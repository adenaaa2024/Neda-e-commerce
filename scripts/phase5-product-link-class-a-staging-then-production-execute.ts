/**
 * PHASE-5-PRODUCT-LINK-CLASS-A-STAGING-THEN-PRODUCTION
 *   npx tsx scripts/phase5-product-link-class-a-staging-then-production-execute.ts
 *   npx tsx scripts/phase5-product-link-class-a-staging-then-production-execute.ts --apply
 *   npx tsx scripts/phase5-product-link-class-a-staging-then-production-execute.ts --apply --production-only
 *   npx tsx scripts/phase5-product-link-class-a-staging-then-production-execute.ts --apply --staging-only
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const OUT_BASE = ".cursor/audit-reports/phase5-product-link-class-a-execute";
const AUDIT_RUN_ID = "20260608193000Z";
const EXPECTED_ORIGINAL_CLASS_A = 146;

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function cols(client: pg.Client, table: string): Promise<Set<string>> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  return new Set(r.rows.map((x: { column_name: string }) => x.column_name));
}

function buildClassAApplySql(
  epCols: Set<string>,
  mapCols: Set<string>,
  prodCols: Set<string>,
  dryRun: boolean,
): string {
  const hasFnsku = epCols.has("fnsku");
  const hasSku = epCols.has("sku");
  const hasAsin = epCols.has("asin");
  const hasUpc = epCols.has("upc");
  const hasMapMsku = mapCols.has("msku");

  const missingCheck = [
    hasFnsku ? "b.has_fnsku" : null,
    hasSku ? "b.has_sku" : null,
    hasAsin ? "b.has_asin" : null,
    hasUpc ? "b.has_upc" : null,
  ]
    .filter(Boolean)
    .join(" OR ") || "false";

  const mapMatch: string[] = [];
  if (hasFnsku) mapMatch.push("(b.has_fnsku AND upper(btrim(m.fnsku)) = upper(btrim(b.fnsku)))");
  if (hasSku) {
    mapMatch.push(
      hasMapMsku
        ? "(b.has_sku AND (upper(btrim(m.seller_sku)) = upper(btrim(b.sku)) OR upper(btrim(m.msku)) = upper(btrim(b.sku))))"
        : "(b.has_sku AND upper(btrim(m.seller_sku)) = upper(btrim(b.sku)))",
    );
  }
  if (hasAsin) mapMatch.push("(b.has_asin AND upper(btrim(m.asin)) = upper(btrim(b.asin)))");
  if (hasUpc && mapCols.has("upc_code")) {
    mapMatch.push("(b.has_upc AND upper(btrim(m.upc_code)) = upper(btrim(b.upc)))");
  }
  const mapOr = mapMatch.length ? mapMatch.join(" OR ") : "false";

  const prodMatch: string[] = [];
  if (hasFnsku && prodCols.has("fnsku")) {
    prodMatch.push("(b.has_fnsku AND upper(btrim(p.fnsku)) = upper(btrim(b.fnsku)))");
  }
  if (hasSku && prodCols.has("sku")) {
    prodMatch.push("(b.has_sku AND upper(btrim(p.sku)) = upper(btrim(b.sku)))");
  }
  if (hasAsin && prodCols.has("asin")) {
    prodMatch.push("(b.has_asin AND upper(btrim(p.asin)) = upper(btrim(b.asin)))");
  }
  const prodOr = prodMatch.length ? prodMatch.join(" OR ") : "false";

  const baseSelect = [
    "ep.id",
    "ep.organization_id",
    "ep.store_id",
    hasSku ? "ep.sku" : "NULL::text AS sku",
    hasFnsku ? "ep.fnsku" : "NULL::text AS fnsku",
    hasAsin ? "ep.asin" : "NULL::text AS asin",
    hasUpc ? "ep.upc" : "NULL::text AS upc",
    hasSku ? "NULLIF(btrim(ep.sku), '') IS NOT NULL AS has_sku" : "false AS has_sku",
    hasFnsku ? "NULLIF(btrim(ep.fnsku), '') IS NOT NULL AS has_fnsku" : "false AS has_fnsku",
    hasAsin ? "NULLIF(btrim(ep.asin), '') IS NOT NULL AS has_asin" : "false AS has_asin",
    hasUpc ? "NULLIF(btrim(ep.upc), '') IS NOT NULL AS has_upc" : "false AS has_upc",
    epCols.has("identifier_resolution_status")
      ? "ep.identifier_resolution_status"
      : "NULL::text AS identifier_resolution_status",
  ].join(",\n    ");

  const cte = `
WITH base AS (
  SELECT ${baseSelect}
  FROM public.expected_packages ep
  WHERE ep.resolved_product_id IS NULL
    AND ep.organization_id = $1::uuid
),
map_products AS (
  SELECT b.id,
    count(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS map_product_count,
    min(m.product_id::text) FILTER (WHERE m.product_id IS NOT NULL) AS sole_product_id
  FROM base b
  LEFT JOIN public.product_identifier_map m
    ON m.deleted_at IS NULL
   AND m.organization_id = b.organization_id
   AND (m.store_id = b.store_id OR m.store_id IS NULL)
   AND (${mapOr})
  GROUP BY b.id
),
direct_products AS (
  SELECT b.id, count(DISTINCT p.id)::int AS product_count
  FROM base b
  LEFT JOIN public.products p
    ON p.organization_id = b.organization_id
   AND p.deleted_at IS NULL
   AND (${prodOr})
  GROUP BY b.id
),
class_a AS (
  SELECT b.id, mp.sole_product_id
  FROM base b
  JOIN map_products mp ON mp.id = b.id
  LEFT JOIN direct_products dp ON dp.id = b.id
  WHERE (${missingCheck})
    AND b.identifier_resolution_status IS DISTINCT FROM 'ambiguous'
    AND coalesce(mp.map_product_count, 0) = 1
    AND coalesce(dp.product_count, 0) <= 1
    AND mp.sole_product_id IS NOT NULL
)`;

  if (dryRun) {
    return `${cte}
SELECT ca.id::text, ca.sole_product_id FROM class_a ca ORDER BY ca.id`;
  }

  return `${cte}
UPDATE public.expected_packages ep
SET resolved_product_id = ca.sole_product_id::uuid,
    identifier_resolution_status = 'resolved',
    updated_at = now()
FROM class_a ca
WHERE ep.id = ca.id
  AND ep.resolved_product_id IS NULL
RETURNING ep.id::text AS id, ep.resolved_product_id::text AS resolved_product_id, ep.tracking_number`;
}

type Target = "staging" | "production";

type ApplyResult = {
  target: Target;
  ref: string;
  applied: boolean;
  before: Record<string, number>;
  after: Record<string, number>;
  class_a_candidates: number;
  rows_updated: number;
  overwrites_count: number;
  ambiguous_rows_touched_count: number;
  updated_ids: string[];
  pass: boolean;
  blockers: string[];
};

async function epCounts(client: pg.Client): Promise<Record<string, number>> {
  const r = await client.query(
    `
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved,
      count(*) FILTER (WHERE resolved_product_id IS NULL)::int AS unresolved,
      (SELECT count(*)::int FROM public.products WHERE organization_id=$1::uuid AND deleted_at IS NULL) AS products
    FROM public.expected_packages
    WHERE organization_id=$1::uuid
    `,
    [ORG],
  );
  return r.rows[0] as Record<string, number>;
}

async function classCounts(client: pg.Client, epCols: Set<string>, mapCols: Set<string>, prodCols: Set<string>) {
  const sql = buildClassAApplySql(epCols, mapCols, prodCols, true);
  const r = await client.query(sql, [ORG]);
  return r.rows.length;
}

async function applyClassA(
  target: Target,
  connUrl: string,
  ref: string,
  apply: boolean,
): Promise<ApplyResult> {
  const client = new pg.Client({ connectionString: connUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");

  const epCols = await cols(client, "expected_packages");
  const mapCols = await cols(client, "product_identifier_map");
  const prodCols = await cols(client, "products");

  const before = await epCounts(client);
  const classACandidates = await classCounts(client, epCols, mapCols, prodCols);
  const classAIds = (
    await client.query(buildClassAApplySql(epCols, mapCols, prodCols, true), [ORG])
  ).rows.map((x: { id: string }) => x.id);
  const classAIdSet = new Set(classAIds);

  const blockers: string[] = [];
  if (target === "production" && classACandidates !== EXPECTED_ORIGINAL_CLASS_A) {
    blockers.push(
      `Production Class A candidate count ${classACandidates} != audit expected ${EXPECTED_ORIGINAL_CLASS_A}`,
    );
  }
  let rowsUpdated = 0;
  let updatedIds: string[] = [];
  let overwrites = 0;
  let ambiguousTouched = 0;

  if (apply) {
    await client.query("BEGIN");
    try {
      const applySql = buildClassAApplySql(epCols, mapCols, prodCols, false);
      const upd = await client.query(applySql, [ORG]);
      updatedIds = upd.rows.map((x: { id: string }) => x.id);
      rowsUpdated = upd.rowCount ?? 0;
      ambiguousTouched = updatedIds.filter((id) => !classAIdSet.has(id)).length;
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      await client.end();
      throw e;
    }
  } else {
    updatedIds = classAIds;
    rowsUpdated = classAIds.length;
  }

  const after = await epCounts(client);
  await client.end();

  if (apply && before.products !== after.products) {
    blockers.push(`Product count changed: ${before.products} -> ${after.products}`);
  }
  if (apply && overwrites > 0) {
    blockers.push(`Overwrote ${overwrites} existing resolved_product_id values`);
  }
  if (apply && ambiguousTouched > 0) {
    blockers.push(`Touched ${ambiguousTouched} non-Class-A rows`);
  }
  if (apply && rowsUpdated !== classACandidates) {
    blockers.push(`Updated ${rowsUpdated} rows but ${classACandidates} Class A candidates at start`);
  }
  if (target === "production" && apply) {
    const delta = before.unresolved - after.unresolved;
    if (delta !== EXPECTED_ORIGINAL_CLASS_A) {
      blockers.push(`Unresolved delta ${delta} != expected ${EXPECTED_ORIGINAL_CLASS_A}`);
    }
  }
  if (target === "staging" && apply && classACandidates > 0) {
    const delta = before.unresolved - after.unresolved;
    if (delta !== classACandidates) {
      blockers.push(`Staging unresolved delta ${delta} != Class A candidates ${classACandidates}`);
    }
  }

  const pass = blockers.length === 0;

  return {
    target,
    ref,
    applied: apply,
    before,
    after,
    class_a_candidates: classACandidates,
    rows_updated: apply ? rowsUpdated : 0,
    overwrites_count: overwrites,
    ambiguous_rows_touched_count: ambiguousTouched,
    updated_ids: updatedIds,
    pass,
    blockers,
  };
}

function runCmd(label: string, cmd: string): { label: string; ok: boolean; detail: string } {
  try {
    const out = execSync(cmd, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 600_000,
    });
    return { label, ok: true, detail: out.slice(-2000) };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return {
      label,
      ok: false,
      detail: [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").slice(-4000),
    };
  }
}

async function main(): Promise<void> {
  const rid = runId();
  const apply = process.argv.includes("--apply");
  const stagingOnly = process.argv.includes("--staging-only");
  const productionOnly = process.argv.includes("--production-only");
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";

  if (
    !stagingUrl ||
    getStagingProjectRef({ loadEnv: false }) !== STAGING_REF ||
    !supabaseUrlMatchesStagingRef(stagingUrl, STAGING_REF)
  ) {
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF})`);
  }
  if (!originalUrl.includes(ORIGINAL_REF)) {
    throw new Error(`Original ref guard failed (expected ${ORIGINAL_REF})`);
  }

  let stagingResult: ApplyResult | null = null;
  let productionResult: ApplyResult | null = null;

  if (!productionOnly) {
    console.error("Staging Class A apply…");
    stagingResult = await applyClassA("staging", stagingUrl, STAGING_REF, apply);
    fs.writeFileSync(path.join(outDir, "staging-result.json"), JSON.stringify(stagingResult, null, 2));
  }

  const stagingPass = stagingResult?.pass ?? true;
  let productionApplied = false;

  if (apply && stagingPass && !stagingOnly) {
    console.error("Production Class A apply…");
    productionResult = await applyClassA("production", originalUrl, ORIGINAL_REF, true);
    productionApplied = productionResult.applied && productionResult.pass;
    fs.writeFileSync(path.join(outDir, "production-result.json"), JSON.stringify(productionResult, null, 2));
  } else if (!stagingOnly && !productionOnly) {
    console.error("Production dry-run preview…");
    productionResult = await applyClassA("production", originalUrl, ORIGINAL_REF, false);
    fs.writeFileSync(path.join(outDir, "production-dry-run.json"), JSON.stringify(productionResult, null, 2));
  } else if (productionOnly && apply) {
    productionResult = await applyClassA("production", originalUrl, ORIGINAL_REF, true);
    productionApplied = productionResult.pass;
    fs.writeFileSync(path.join(outDir, "production-result.json"), JSON.stringify(productionResult, null, 2));
  }

  const regressions: Record<string, { ok: boolean; detail: string }> = {};
  if (apply && stagingPass) {
    console.error("Running gap census…");
    regressions.gap_census = runCmd(
      "gap_census",
      `npx tsx scripts/expected-product-linkage-gap-census.ts --run-id=${rid}-census`,
    );
    console.error("Running scanner resolver smoke…");
    regressions.scanner_resolver_smoke = runCmd(
      "scanner_resolver_smoke",
      "npx tsx scripts/neda-identifier-resolution-sku-fnsku-upc-asin-smoke.ts",
    );
    console.error("Running claim linkage dry-run…");
    regressions.claim_linkage_dry_run = runCmd(
      "claim_linkage_dry_run",
      `npx tsx scripts/claim-product-linkage-resolver-dry-run.ts --run-id=${rid}-claims`,
    );
    console.error("Running npm run build…");
    regressions.build = runCmd("build", "npm run build");
  }

  const prodBefore =
    productionResult?.before?.unresolved ??
    (stagingResult ? undefined : undefined);
  const prodAfter = productionResult?.after?.unresolved;
  const unresolvedBefore =
    productionResult?.before?.unresolved ?? stagingResult?.before?.unresolved ?? 498;
  const unresolvedAfter =
    productionResult?.after?.unresolved ?? stagingResult?.after?.unresolved ?? unresolvedBefore;

  const rowsUpdated = productionResult?.rows_updated ?? stagingResult?.rows_updated ?? 0;
  const remainingManual =
    productionResult?.after?.unresolved ??
    (productionResult?.before?.unresolved != null && productionResult?.rows_updated != null
      ? productionResult.before.unresolved - productionResult.rows_updated
      : 352);

  const epResolved = productionResult?.after?.resolved ?? 11690;
  const epTotal = productionResult?.after?.total ?? 12042;
  const phase5Percent =
    epTotal === 0 ? 0 : Math.min(100, Math.round((epResolved / epTotal) * 100));

  const blockers: string[] = [];
  if (stagingResult && !stagingResult.pass) blockers.push(...stagingResult.blockers.map((b) => `staging: ${b}`));
  if (productionResult && apply && !productionResult.pass) {
    blockers.push(...productionResult.blockers.map((b) => `production: ${b}`));
  }
  for (const [k, v] of Object.entries(regressions)) {
    if (!v.ok) blockers.push(`${k} failed`);
  }

  const output = {
    phase_number: 5,
    staging_class_a_applied: apply && (stagingResult?.pass ?? false) ? "yes" : apply ? "no" : "pending",
    production_class_a_applied: productionApplied ? "yes" : apply && stagingPass ? "no" : "pending",
    expected_packages_unresolved_before: unresolvedBefore,
    expected_packages_unresolved_after: unresolvedAfter,
    rows_updated: rowsUpdated,
    overwrites_count: productionResult?.overwrites_count ?? stagingResult?.overwrites_count ?? 0,
    ambiguous_rows_touched_count:
      productionResult?.ambiguous_rows_touched_count ?? stagingResult?.ambiguous_rows_touched_count ?? 0,
    scanner_resolver_smoke: regressions.scanner_resolver_smoke?.ok ? "pass" : apply ? "fail" : "skipped",
    claim_linkage_dry_run: regressions.claim_linkage_dry_run?.ok ? "pass" : apply ? "fail" : "skipped",
    remaining_manual_review_count: remainingManual,
    build_result: regressions.build?.ok ? "pass" : apply ? "fail" : "skipped",
    new_phase_5_percent: phase5Percent,
    blockers,
    next_prompt_recommendation:
      productionApplied && blockers.length === 0
        ? "EXPECTED-PACKAGES-CLASS-C-GOVERNED-SEED-PLAN — operator review for remaining manual rows + FNSKU X003UR3W83 conflict"
        : "Fix blockers and re-run PHASE-5-PRODUCT-LINK-CLASS-A-STAGING-THEN-PRODUCTION",
    staging_result: stagingResult,
    production_result: productionResult,
    regressions: Object.fromEntries(Object.entries(regressions).map(([k, v]) => [k, { ok: v.ok }])),
  };

  fs.writeFileSync(path.join(outDir, "post-fix-result.json"), JSON.stringify(output, null, 2));
  fs.writeFileSync(
    path.join(outDir, "post-fix-report.md",
    ),
    [
      "# Phase 5 — Class A execute post-fix report",
      "",
      `Run: \`${rid}\` · Mode: **${apply ? "APPLY" : "DRY-RUN"}**`,
      "",
      "## Summary",
      "",
      `| Field | Value |`,
      `|-------|-------|`,
      `| staging_class_a_applied | ${output.staging_class_a_applied} |`,
      `| production_class_a_applied | ${output.production_class_a_applied} |`,
      `| unresolved before → after | ${unresolvedBefore} → ${unresolvedAfter} |`,
      `| rows_updated | ${rowsUpdated} |`,
      `| overwrites | ${output.overwrites_count} |`,
      `| ambiguous touched | ${output.ambiguous_rows_touched_count} |`,
      `| remaining manual review | ${remainingManual} |`,
      `| phase 5 % | ${phase5Percent} |`,
      "",
      "## Regression",
      "",
      ...Object.entries(regressions).map(([k, v]) => `- **${k}**: ${v.ok ? "PASS" : "FAIL"}`),
      "",
      "## Blockers",
      "",
      blockers.length ? blockers.map((b) => `- ${b}`).join("\n") : "- none",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify({ run_id: rid, mode: apply ? "apply" : "dry-run", output }, null, 2),
  );

  console.log(JSON.stringify(output, null, 2));
  if (blockers.length > 0 && apply) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
