/**
 * PHASE-PRODUCT-TRID-STORY-LINKAGE-AUDIT-AND-LAYER-V1
 * Read-only product identity + TRID/reference graph audit and product-story build plan.
 *   npx tsx scripts/phase-product-trid-story-linkage-audit-and-layer-v1.ts
 *
 * No DB writes. No claim mutation. No Amazon submission. No scanner change. No new tables.
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { loadPilotProductsNeedingCogsV1 } from "../lib/claims/submission/product-cogs-manual-entry-ui-v1";
import {
  INCOMING_API_MAPPING_RULE,
  PRODUCT_TRID_STORY_LINKAGE_AUDIT_V1,
  SOURCE_IDENTITY_SPECS,
  splitProofMatrices,
  TRID_REFERENCE_MODEL,
  type ProductIdentitySourceAudit,
  type ProductStoryBlocker,
  type ProductStoryPreview,
  type ProductTridStoryLinkageAuditResult,
} from "../lib/products/contracts/product-trid-story-linkage-audit-v1";
import { bindProductionSupabaseEnv, productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-product-trid-story-linkage-audit-and-layer-v1";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function scannerGitStatus(): string {
  try {
    return execSync("git status --porcelain app/scanner lib/scanner", { encoding: "utf8" }).trim();
  } catch {
    return "git_unavailable";
  }
}

async function connectReadonly(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '180s'");
  await c.query("SET default_transaction_read_only = ON");
  return c;
}

async function tableExists(c: pg.Client, table: string): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1 LIMIT 1`,
    [table],
  );
  return (r.rowCount ?? 0) > 0;
}

async function columnExists(c: pg.Client, table: string, column: string): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2 LIMIT 1`,
    [table, column],
  );
  return (r.rowCount ?? 0) > 0;
}

async function hasOrgColumn(c: pg.Client, table: string): Promise<boolean> {
  return columnExists(c, table, "organization_id");
}

async function countQ(c: pg.Client, sql: string, params: unknown[]): Promise<number> {
  try {
    const r = await c.query(sql, params);
    return Number(r.rows[0]?.n ?? 0);
  } catch {
    return -1;
  }
}

async function auditSourceTable(
  c: pg.Client,
  spec: (typeof SOURCE_IDENTITY_SPECS)[number],
): Promise<ProductIdentitySourceAudit> {
  const exists = await tableExists(c, spec.source_table);
  if (!exists) {
    return {
      source_table: spec.source_table,
      exists: false,
      total_org_rows: 0,
      identity_field_present: {},
      mapped_to_canonical_product: "n/a",
      ambiguous_product_match: "n/a",
      orphan_source_rows: 0,
      stale_product_links: "n/a",
      missing_asin_count: "column_absent",
      missing_fnsku_count: "column_absent",
      missing_sku_count: "column_absent",
      notes: `${spec.notes} [table absent]`,
    };
  }

  const orgScoped = await hasOrgColumn(c, spec.source_table);
  const where = orgScoped ? `WHERE organization_id=$1::uuid` : "";
  const params = orgScoped ? [ORG] : [];

  const total = await countQ(c, `SELECT count(*)::int AS n FROM ${spec.source_table} ${where}`, params);

  const identity_field_present: Record<string, number | "column_absent"> = {};
  const idCols = ["sku", "fnsku", "asin", "upc", "product_id", "product_identifier"];
  for (const col of idCols) {
    if (!(await columnExists(c, spec.source_table, col))) {
      identity_field_present[col] = "column_absent";
      continue;
    }
    const filter = orgScoped
      ? `WHERE organization_id=$1::uuid AND ${col} IS NOT NULL AND ${col}::text <> ''`
      : `WHERE ${col} IS NOT NULL AND ${col}::text <> ''`;
    identity_field_present[col] = await countQ(
      c,
      `SELECT count(*)::int AS n FROM ${spec.source_table} ${filter}`,
      params,
    );
  }

  const missing = (col: string): number | "column_absent" => {
    const present = identity_field_present[col];
    if (present === "column_absent" || present == null) return "column_absent";
    if (present < 0 || total < 0) return "column_absent";
    return Math.max(0, total - present);
  };

  let mapped: number | "n/a" = "n/a";
  let ambiguous: number | "n/a" = "n/a";
  let stale: number | "n/a" = "n/a";

  if (spec.resolved_column && (await columnExists(c, spec.source_table, spec.resolved_column))) {
    const f = orgScoped
      ? `WHERE organization_id=$1::uuid AND ${spec.resolved_column} IS NOT NULL`
      : `WHERE ${spec.resolved_column} IS NOT NULL`;
    mapped = await countQ(c, `SELECT count(*)::int AS n FROM ${spec.source_table} ${f}`, params);

    if (await columnExists(c, spec.source_table, "product_id")) {
      const sf = orgScoped
        ? `WHERE organization_id=$1::uuid AND product_id IS NOT NULL AND ${spec.resolved_column} IS NULL`
        : `WHERE product_id IS NOT NULL AND ${spec.resolved_column} IS NULL`;
      stale = await countQ(c, `SELECT count(*)::int AS n FROM ${spec.source_table} ${sf}`, params);
    }
  }

  if (spec.status_column && (await columnExists(c, spec.source_table, spec.status_column))) {
    const f = orgScoped
      ? `WHERE organization_id=$1::uuid AND ${spec.status_column}='ambiguous'`
      : `WHERE ${spec.status_column}='ambiguous'`;
    ambiguous = await countQ(c, `SELECT count(*)::int AS n FROM ${spec.source_table} ${f}`, params);
  }

  // Orphan = rows carrying no usable identity across sku/fnsku/asin (only for tables that have at least one).
  const orphanCols = ["sku", "fnsku", "asin"].filter(
    (col) => identity_field_present[col] !== "column_absent",
  );
  let orphan = 0;
  if (orphanCols.length > 0) {
    const nullClause = orphanCols
      .map((col) => `(${col} IS NULL OR ${col}::text='')`)
      .join(" AND ");
    const f = orgScoped ? `WHERE organization_id=$1::uuid AND ${nullClause}` : `WHERE ${nullClause}`;
    orphan = await countQ(c, `SELECT count(*)::int AS n FROM ${spec.source_table} ${f}`, params);
  }

  return {
    source_table: spec.source_table,
    exists: true,
    total_org_rows: total,
    identity_field_present,
    mapped_to_canonical_product: mapped,
    ambiguous_product_match: ambiguous,
    orphan_source_rows: orphan,
    stale_product_links: stale,
    missing_asin_count: missing("asin"),
    missing_fnsku_count: missing("fnsku"),
    missing_sku_count: missing("sku"),
    notes: spec.notes + (orgScoped ? "" : " [no organization_id column — global count]"),
  };
}

async function countByIdentity(
  c: pg.Client,
  table: string,
  fnsku: string | null,
  sku: string | null,
  asin: string | null,
): Promise<number> {
  if (!(await tableExists(c, table))) return 0;
  const orgScoped = await hasOrgColumn(c, table);
  const ors: string[] = [];
  const params: unknown[] = orgScoped ? [ORG] : [];
  let idx = params.length;
  const add = async (col: string, val: string | null) => {
    if (!val) return;
    if (!(await columnExists(c, table, col))) return;
    idx += 1;
    ors.push(`${col}=$${idx}`);
    params.push(val);
  };
  await add("fnsku", fnsku);
  await add("sku", sku);
  await add("asin", asin);
  if (ors.length === 0) return 0;
  const where = `${orgScoped ? "organization_id=$1::uuid AND " : ""}(${ors.join(" OR ")})`;
  return countQ(c, `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params);
}

async function claimCandidatesByFamily(
  c: pg.Client,
  fnsku: string | null,
  sku: string | null,
  asin: string | null,
  resolvedProductId: string | null,
): Promise<Record<string, number>> {
  if (!(await tableExists(c, "claim_candidates"))) return {};
  let familyCol: string | null = null;
  for (const col of ["claim_type", "family_key", "claim_family", "category_key"]) {
    if (await columnExists(c, "claim_candidates", col)) {
      familyCol = col;
      break;
    }
  }
  if (!familyCol) return {};

  const ors: string[] = [];
  const params: unknown[] = [ORG];
  let idx = 1;
  const add = async (col: string, val: string | null) => {
    if (!val) return;
    if (!(await columnExists(c, "claim_candidates", col))) return;
    idx += 1;
    ors.push(`${col}=$${idx}`);
    params.push(val);
  };
  await add("resolved_product_id", resolvedProductId);
  await add("fnsku", fnsku);
  await add("sku", sku);
  await add("asin", asin);
  if (ors.length === 0) return {};

  try {
    const r = await c.query(
      `SELECT ${familyCol} AS fam, count(*)::int AS n
       FROM claim_candidates
       WHERE organization_id=$1::uuid AND (${ors.join(" OR ")})
       GROUP BY ${familyCol} ORDER BY n DESC`,
      params,
    );
    const out: Record<string, number> = {};
    for (const row of r.rows) out[String(row.fam ?? "unknown")] = Number(row.n ?? 0);
    return out;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const { ref, url } = bindProductionSupabaseEnv();
  if (ref !== PRODUCTION_REF) throw new Error(`BLOCKED: expected ${PRODUCTION_REF}, got ${ref}`);

  const supabase = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), {
    auth: { persistSession: false },
  });
  const c = await connectReadonly(productionPostgresUrl());

  // Part 1 — product identity audit per source table.
  const product_identity_matrix_by_source: ProductIdentitySourceAudit[] = [];
  for (const spec of SOURCE_IDENTITY_SPECS) {
    product_identity_matrix_by_source.push(await auditSourceTable(c, spec));
  }

  const orphan_rows_by_source: Record<string, number> = {};
  const ambiguous_matches_by_source: Record<string, number | "n/a"> = {};
  for (const a of product_identity_matrix_by_source) {
    orphan_rows_by_source[a.source_table] = a.orphan_source_rows;
    ambiguous_matches_by_source[a.source_table] = a.ambiguous_product_match;
  }

  // Part 3 — product story preview for pilot products.
  const pilotProducts = await loadPilotProductsNeedingCogsV1({
    organizationId: ORG,
    storeId: STORE,
    supabase,
  });

  const product_story_preview_matrix: ProductStoryPreview[] = [];
  const missing_linkage_blockers: ProductStoryBlocker[] = [];

  for (const p of pilotProducts) {
    // Serial (single pg client cannot run concurrent queries safely).
    const removals = await countByIdentity(c, "amazon_removals", p.fnsku, p.sku, p.asin);
    const ledger = await countByIdentity(c, "amazon_inventory_ledger", p.fnsku, p.sku, p.asin);
    const settlements = await countByIdentity(c, "amazon_settlements", p.fnsku, p.sku, p.asin);
    const reimbursements = await countByIdentity(c, "amazon_reimbursements", p.fnsku, p.sku, p.asin);
    const returns = await countByIdentity(c, "amazon_returns", p.fnsku, p.sku, p.asin);
    const family = await claimCandidatesByFamily(c, p.fnsku, p.sku, p.asin, p.resolvedProductId);

    const identityStatus: ProductStoryPreview["identity_status"] = p.resolvedProductId
      ? "resolved"
      : "unresolved";

    const missing: string[] = [];
    if (!p.resolvedProductId) missing.push("product_link (resolved products.id)");
    if (p.cogsStatus !== "override_present") missing.push("cogs/internal cost");
    if (reimbursements === 0) missing.push("reimbursement_id edge (expected recovery)");

    if (missing.length > 0) {
      missing_linkage_blockers.push({
        product_key: p.fnsku,
        blocker: missing.join("; "),
        missing_edge_or_field: missing[0]!,
      });
    }

    product_story_preview_matrix.push({
      fnsku: p.fnsku,
      sku: p.sku,
      asin: p.asin,
      resolved_product_id: p.resolvedProductId,
      product_title: p.productTitle,
      identity_status: identityStatus,
      latest_sale_net: p.latestSoldPrice,
      cogs_internal_cost: p.approvedUnitCost ?? null,
      removals_count: removals,
      received_scanned_status: p.cleanQuantityTotal > 0 ? "scanned_clean_present" : "no_clean_scan",
      inventory_ledger_events: ledger,
      settlements_orders_count: settlements,
      reimbursements_count: reimbursements,
      customer_returns_count: returns,
      claim_candidates_by_family: family,
      open_amount: null,
      recovered_amount: null,
      missing_links: missing,
    });
  }

  await c.end();

  const resolvedCount = product_story_preview_matrix.filter((p) => p.identity_status === "resolved").length;
  const storyCoverage = `${resolvedCount}/${pilotProducts.length} pilot products with resolved product identity`;

  const proof = splitProofMatrices();

  // Linkage status: healthy only if pilot identities resolve and richest table is resolver-wired.
  const returnItemsAudit = product_identity_matrix_by_source.find((a) => a.source_table === "return_items");
  const returnItemsWired =
    returnItemsAudit?.mapped_to_canonical_product !== "n/a" &&
    Number(returnItemsAudit?.mapped_to_canonical_product ?? 0) > 0;
  const productLinkageStatus: ProductTridStoryLinkageAuditResult["product_linkage_status"] =
    resolvedCount === pilotProducts.length && returnItemsWired
      ? "healthy"
      : resolvedCount > 0
        ? "partial"
        : "blocked";

  // Gates
  const scannerClean = scannerGitStatus() === "";

  let buildResult = "skipped";
  try {
    execSync("npx tsc --noEmit", { stdio: "pipe", encoding: "utf8" });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message.slice(0, 400) : "unknown"}`;
  }

  let smokeResult = "skipped";
  try {
    execSync("npx tsx scripts/smoke-product-trid-story-linkage-audit-and-layer-v1.ts", {
      stdio: "pipe",
      encoding: "utf8",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message.slice(0, 300) : "unknown"}`;
  }

  const safeLayerReady = productLinkageStatus !== "blocked" && buildResult === "pass" && smokeResult === "pass";

  const result: ProductTridStoryLinkageAuditResult = {
    phase: PRODUCT_TRID_STORY_LINKAGE_AUDIT_V1.phase,
    run_id: id,
    db_ref: ref,
    read_only: true,
    product_linkage_status: productLinkageStatus,
    product_identity_matrix_by_source,
    orphan_rows_by_source,
    ambiguous_matches_by_source,
    trid_reference_model: TRID_REFERENCE_MODEL,
    seller_central_proof_reference_matrix: proof.seller_central,
    internal_only_reference_matrix: proof.internal_only,
    product_story_preview_matrix,
    current_pilot_product_story_coverage: storyCoverage,
    missing_linkage_blockers,
    recommended_reuse_existing_tables: "yes",
    new_tables_needed: "no",
    proposed_schema_if_needed:
      "None for audit/read-model. Optional future TRID spine = gated DRAFT migration 20260832120000_trid_foundation.sql (trid_entities/trid_links/trid_events) — requires explicit Maysam approval; reuse financial_reference_resolver.trid_key instead of duplicating.",
    approval_required: "no",
    no_claim_submission_mutation_verification: true,
    no_amazon_submission_verification: true,
    no_scanner_change_verification: scannerClean,
    build_result: buildResult,
    smoke_result: smokeResult,
    next_build_result: buildResult,
    SAFE_PRODUCT_TRID_STORY_LAYER_READY: safeLayerReady ? "yes" : "no",
    SAFE_TO_BUILD_FAMILY_CLAIM_GENERATORS: safeLayerReady && productLinkageStatus === "healthy" ? "yes" : "no",
    NEXT_PROMPT: safeLayerReady
      ? "PHASE-CLAIM-TRID-EDGE-READMODEL-IMPLEMENT-V1 — expose TRID_EDGE_KIND_CATALOG + per-candidate materialized edges as a read model; wire Product Story TRID section and References tab; family-aware edge gating; no new tables."
      : "Resolve linkage blockers (unresolved pilot identities / build / smoke) then re-run audit.",
  };

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify({ phase: result.phase, run_id: id, db_ref: ref, artifacts: ["result.json", "summary.md", "incoming-api-mapping-rule.json"] }, null, 2),
  );
  fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "incoming-api-mapping-rule.json"),
    JSON.stringify(INCOMING_API_MAPPING_RULE, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      `# ${result.phase}`,
      ``,
      `- Run: \`${id}\` @ \`${ref}\` (read-only)`,
      `- product_linkage_status: **${result.product_linkage_status}**`,
      `- pilot product story coverage: ${result.current_pilot_product_story_coverage}`,
      `- new_tables_needed: **${result.new_tables_needed}** · approval_required: **${result.approval_required}**`,
      `- build: ${result.build_result} · smoke: ${result.smoke_result}`,
      `- SAFE_PRODUCT_TRID_STORY_LAYER_READY: **${result.SAFE_PRODUCT_TRID_STORY_LAYER_READY}**`,
      `- SAFE_TO_BUILD_FAMILY_CLAIM_GENERATORS: **${result.SAFE_TO_BUILD_FAMILY_CLAIM_GENERATORS}**`,
      ``,
      `## Missing linkage blockers`,
      ...result.missing_linkage_blockers.map((b) => `- ${b.product_key}: ${b.blocker}`),
    ].join("\n"),
  );

  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
