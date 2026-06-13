/**
 * PHASE-CLAIM-MONEY-RECOVERY-DATA-CONTRACT-AUDIT (read-only)
 * npx tsx scripts/phase-claim-money-recovery-data-contract-audit.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const DEFAULT_ORG = "7397edff-7994-4731-8501-55d258d507d2";
const OUT_BASE = ".cursor/audit-reports/phase-claim-money-recovery-data-contract-audit";

async function safeQuery(c: pg.Client, sql: string, params: unknown[] = []): Promise<unknown> {
  try {
    return (await c.query(sql, params)).rows;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  if (getStagingProjectRef() !== STAGING_REF) throw new Error("Staging ref guard failed");

  const url = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? process.env.DIRECT_POSTGRES_URL?.trim() ?? "";
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  await client.connect();
  await client.query("SET statement_timeout = '120s'");

  const orgId = process.env.CLAIM_AUDIT_ORG_ID?.trim() || DEFAULT_ORG;
  const activeFilter = `organization_id = $1::uuid AND quarantined_at IS NULL AND COALESCE(source_kind, '') <> 'legacy_seed'`;

  const claimCandidateMoneyCols = await safeQuery(
    client,
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'claim_candidates'
       AND column_name ~* '(amount|recovery|cogs|currency|quantity|status|metadata|reference)'
     ORDER BY column_name`,
  );

  const phantomCols = await safeQuery(
    client,
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'claim_candidates'
       AND column_name IN (
         'estimated_recovery_amount', 'recoverable_amount', 'claim_amount',
         'recovery_value', 'cogs_unit', 'cogs_source_code', 'expected_amount'
       )`,
  );

  const ccMoneyBreakdown = await safeQuery(
    client,
    `SELECT
      source_kind,
      claim_family,
      COUNT(*)::int AS n,
      COUNT(*) FILTER (WHERE recovery_value IS NULL)::int AS rv_null,
      COUNT(*) FILTER (WHERE recovery_value = 0)::int AS rv_zero,
      COUNT(*) FILTER (WHERE recovery_value > 0)::int AS rv_positive,
      COUNT(*) FILTER (WHERE cogs_unit IS NOT NULL AND cogs_unit > 0)::int AS cogs_present,
      COUNT(*) FILTER (WHERE metadata ? 'orbit_external_case_status')::int AS ext_status_meta,
      COUNT(*) FILTER (WHERE metadata ? 'external_case_status')::int AS ext_status_alt
     FROM claim_candidates
     WHERE ${activeFilter}
     GROUP BY 1, 2
     ORDER BY n DESC`,
    [orgId],
  );

  const ccSamples = await safeQuery(
    client,
    `SELECT
      id::text,
      source_kind,
      claim_family,
      recovery_value,
      cogs_unit,
      currency,
      expected_quantity,
      actual_quantity,
      reference_id,
      reference_type,
      return_item_id::text,
      metadata->>'orbit_external_case_status' AS orbit_external_case_status,
      metadata->>'external_case_status' AS external_case_status,
      metadata->>'expected_amount' AS metadata_expected_amount,
      metadata->'units_affected' AS units_affected,
      metadata->>'orbit_source_report' AS orbit_source_report
     FROM claim_candidates
     WHERE ${activeFilter}
     ORDER BY created_at DESC
     LIMIT 8`,
    [orgId],
  );

  const metadataKeys = await safeQuery(
    client,
    `SELECT jsonb_object_keys(metadata) AS k, COUNT(*)::int AS n
     FROM claim_candidates WHERE ${activeFilter}
     GROUP BY 1 ORDER BY n DESC LIMIT 40`,
    [orgId],
  );

  const frrSummary = await safeQuery(
    client,
    `SELECT
      COUNT(*)::int AS total_rows,
      COUNT(DISTINCT order_id) FILTER (WHERE order_id IS NOT NULL AND btrim(order_id) <> '')::int AS distinct_orders,
      COUNT(DISTINCT trid_key)::int AS distinct_trids,
      COUNT(*) FILTER (WHERE amount IS NOT NULL AND amount <> 0)::int AS with_amount,
      COUNT(*) FILTER (WHERE confidence_score IS NOT NULL)::int AS with_confidence,
      COUNT(DISTINCT source_table)::int AS source_tables
     FROM financial_reference_resolver
     WHERE organization_id = $1::uuid`,
    [orgId],
  );

  const reimbSummary = await safeQuery(
    client,
    `SELECT
      COUNT(*)::int AS total_rows,
      COUNT(*) FILTER (WHERE amount_reimbursed IS NOT NULL AND amount_reimbursed <> 0)::int AS with_amount,
      COUNT(DISTINCT order_id) FILTER (WHERE order_id IS NOT NULL)::int AS distinct_orders,
      COUNT(DISTINCT reimbursement_id)::int AS distinct_reimbursement_ids
     FROM amazon_reimbursements
     WHERE organization_id = $1::uuid`,
    [orgId],
  );

  const txnSummary = await safeQuery(
    client,
    `SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE amount IS NOT NULL AND amount <> 0)::int AS with_amount
     FROM amazon_transactions WHERE organization_id = $1::uuid`,
    [orgId],
  );

  const settlementSummary = await safeQuery(
    client,
    `SELECT COUNT(*)::int AS total FROM amazon_settlements WHERE organization_id = $1::uuid`,
    [orgId],
  );

  const edgeSummary = await safeQuery(
    client,
    `SELECT
      COUNT(*)::int AS total_edges,
      COUNT(DISTINCT candidate_id) FILTER (WHERE candidate_id IS NOT NULL)::int AS candidates_with_edges,
      COUNT(*) FILTER (WHERE to_kind = 'financial_reference_resolver' OR from_kind = 'financial_reference_resolver')::int AS frr_edges
     FROM claim_reference_edges
     WHERE organization_id = $1::uuid`,
    [orgId],
  );

  const candidateFrrJoin = await safeQuery(
    client,
    `WITH active AS (
       SELECT id, source_kind, reference_id, reference_type, return_item_id, metadata
       FROM claim_candidates WHERE ${activeFilter}
     ),
     ri_orders AS (
       SELECT a.id AS candidate_id, ri.order_id
       FROM active a
       LEFT JOIN return_items ri ON ri.id = a.return_item_id
     ),
     pkg_orders AS (
       SELECT a.id AS candidate_id, p.order_id
       FROM active a
       JOIN packages p ON p.id::text = a.reference_id AND a.reference_type = 'package_id'
     )
     SELECT
       (SELECT COUNT(*)::int FROM active) AS active_candidates,
       (SELECT COUNT(DISTINCT candidate_id)::int FROM ri_orders WHERE order_id IS NOT NULL) AS with_order_via_return_item,
       (SELECT COUNT(DISTINCT candidate_id)::int FROM pkg_orders WHERE order_id IS NOT NULL) AS with_order_via_package_ref,
       (SELECT COUNT(DISTINCT a.id)::int
        FROM active a
        JOIN ri_orders r ON r.candidate_id = a.id
        JOIN financial_reference_resolver f ON f.organization_id = $1::uuid AND f.order_id = r.order_id
       ) AS candidates_joinable_to_frr,
       (SELECT COUNT(DISTINCT a.id)::int
        FROM active a
        JOIN claim_reference_edges e ON e.candidate_id = a.id AND e.organization_id = $1::uuid
       ) AS candidates_with_materialized_edges`,
    [orgId],
  );

  const reimbCandidateLink = await safeQuery(
    client,
    `SELECT
      (SELECT COUNT(*)::int FROM amazon_reimbursements WHERE organization_id = $1::uuid) AS reimb_rows,
      (SELECT COUNT(*)::int FROM claim_candidates cc
        WHERE ${activeFilter} AND cc.source_kind = 'reimbursement') AS reimbursement_source_candidates,
      (SELECT COUNT(*)::int FROM claim_candidates cc
        WHERE ${activeFilter}
          AND cc.metadata->>'amazon_reimbursement_id' IS NOT NULL) AS candidates_with_reimb_meta`,
    [orgId],
  );

  const productCogs = await safeQuery(
    client,
    `SELECT
      COUNT(*)::int AS products_total,
      COUNT(*) FILTER (WHERE cogs_unit IS NOT NULL AND cogs_unit > 0)::int AS products_with_cogs_unit
     FROM products WHERE organization_id = $1::uuid AND deleted_at IS NULL`,
    [orgId],
  );

  const cogsSourceCodeCol = await safeQuery(
    client,
    `SELECT column_name, table_name FROM information_schema.columns
     WHERE table_schema = 'public'
       AND column_name = 'cogs_source_code'
       AND table_name IN ('claim_candidates', 'products')`,
  );

  await client.end();

  const phantom = Array.isArray(phantomCols) ? phantomCols : [];
  const hasEstimated = phantom.some((r) => (r as { column_name: string }).column_name === "estimated_recovery_amount");
  const hasRecoverableCol = phantom.some((r) => (r as { column_name: string }).column_name === "recoverable_amount");
  const hasClaimAmountCol = phantom.some((r) => (r as { column_name: string }).column_name === "claim_amount");
  const hasCogsSource = phantom.some((r) => (r as { column_name: string }).column_name === "cogs_source_code");

  const breakdown = Array.isArray(ccMoneyBreakdown) ? ccMoneyBreakdown : [];
  const totalActive = breakdown.reduce((s, r) => s + Number((r as { n: number }).n ?? 0), 0);
  const withPositiveRv = breakdown.reduce((s, r) => s + Number((r as { rv_positive: number }).rv_positive ?? 0), 0);

  const report = {
    run_id: runId,
    organization_id: orgId,
    staging_ref: STAGING_REF,
    schema_inventory: {
      claim_candidates_money_columns: claimCandidateMoneyCols,
      phantom_column_check: {
        estimated_recovery_amount_exists: hasEstimated,
        recoverable_amount_exists: hasRecoverableCol,
        claim_amount_on_candidates_exists: hasClaimAmountCol,
        cogs_source_code_exists: hasCogsSource,
        present_columns: phantom,
      },
      cogs_source_code_columns: cogsSourceCodeCol,
    },
    staging_money_breakdown: ccMoneyBreakdown,
    staging_samples: ccSamples,
    metadata_keys: metadataKeys,
    financial_sources: {
      financial_reference_resolver: frrSummary,
      amazon_reimbursements: reimbSummary,
      amazon_transactions: txnSummary,
      amazon_settlements: settlementSummary,
    },
    linkage: {
      claim_reference_edges: edgeSummary,
      candidate_frr_join: candidateFrrJoin,
      reimbursement_candidate_link: reimbCandidateLink,
    },
    product_cogs: productCogs,
    SAFE_TO_IMPLEMENT_MONEY_UI: withPositiveRv > 0 && totalActive > 0 ? "yes_with_contract" : totalActive > 0 ? "no_until_amount_semantics_fixed" : "no",
    NEXT_EXACT_PROMPT: "PHASE-CLAIM-CENTER-QUEUE-SEMANTICS-AND-MONEY-DISPLAY-POLISH-V1",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, "summary.md"), renderSummary(report, totalActive, withPositiveRv));
  console.log(JSON.stringify({ ok: true, run_id: runId, outDir, SAFE: report.SAFE_TO_IMPLEMENT_MONEY_UI, totalActive, withPositiveRv }));
}

function renderSummary(report: Record<string, unknown>, active: number, positiveRv: number): string {
  const phantom = (report.schema_inventory as Record<string, unknown>).phantom_column_check as Record<string, unknown>;
  return `# PHASE-CLAIM-MONEY-RECOVERY-DATA-CONTRACT-AUDIT

**Run:** ${report.run_id} | **Org:** ${report.organization_id}

## Schema truth
- \`estimated_recovery_amount\` on claim_candidates: **${phantom.estimated_recovery_amount_exists}**
- \`recoverable_amount\` on claim_candidates: **${phantom.recoverable_amount_exists}**
- \`claim_amount\` on claim_candidates: **${phantom.claim_amount_on_candidates_exists}** (lives on claim_submissions)
- Canonical expected column: **recovery_value** + **cogs_unit**

## Staging
- Active candidates: **${active}**
- With recovery_value > 0: **${positiveRv}**

## SAFE_TO_IMPLEMENT_MONEY_UI: **${report.SAFE_TO_IMPLEMENT_MONEY_UI}**

## NEXT: ${report.NEXT_EXACT_PROMPT}
`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
