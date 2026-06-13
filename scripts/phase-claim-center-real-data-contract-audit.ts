/**
 * PHASE-CLAIM-CENTER-REAL-DATA-CONTRACT-AUDIT (read-only)
 * npx tsx scripts/phase-claim-center-real-data-contract-audit.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const DEFAULT_ORG = "00000000-0000-0000-0000-000000000001";
const OUT_BASE = ".cursor/audit-reports/phase-claim-center-real-data-contract-audit";
const FAKE_RETURN_IDS = [
  "23ccf73f-cbda-485e-9ebb-cc8e365b9172",
  "3270ee19-441d-4b30-9d66-0273c46ea247",
  "ccffe8b3-87ea-4b7b-bfd5-4cf9cc16d663",
  "e08156b5-6f59-4bad-9a33-330c500df9cd",
];

async function tableExists(c: pg.Client, t: string): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [t],
  );
  return (r.rowCount ?? 0) > 0;
}

async function colExists(c: pg.Client, t: string, col: string): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [t, col],
  );
  return (r.rowCount ?? 0) > 0;
}

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

  const tables = [
    "claim_candidates",
    "claim_reference_edges",
    "claim_cases",
    "claim_submissions",
    "claim_evidence",
    "claim_evidence_lineage_events",
    "financial_reference_resolver",
    "claim_candidate_drafts",
    "claim_review_work_items",
    "products",
    "product_identifier_map",
    "return_items",
    "amazon_reimbursements",
    "organization_settings",
  ];
  const tableExistsMap: Record<string, boolean> = {};
  for (const t of tables) tableExistsMap[t] = await tableExists(client, t);

  const hasCandidateIdOnEdges = tableExistsMap.claim_reference_edges
    ? await colExists(client, "claim_reference_edges", "candidate_id")
    : false;

  const ccActiveFilter = `
    organization_id = $1::uuid
    AND quarantined_at IS NULL
    AND COALESCE(source_kind, '') <> 'legacy_seed'
  `;

  const ccTotals = await safeQuery(
    client,
    `SELECT
      COUNT(*)::int AS total_all,
      COUNT(*) FILTER (WHERE ${ccActiveFilter.replace(/\$1/g, "$1")})::int AS active_default,
      COUNT(*) FILTER (WHERE source_kind = 'legacy_seed')::int AS legacy_seed,
      COUNT(*) FILTER (WHERE quarantined_at IS NOT NULL)::int AS quarantined,
      COUNT(*) FILTER (WHERE organization_id IS NULL)::int AS missing_org,
      COUNT(*) FILTER (WHERE store_id IS NULL)::int AS missing_store,
      COUNT(*) FILTER (WHERE recovery_value IS NOT NULL AND recovery_value > 0)::int AS with_recovery_value,
      COUNT(*) FILTER (WHERE cogs_unit IS NOT NULL)::int AS with_cogs_unit,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS with_resolved_product,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM products p WHERE p.id = claim_candidates.resolved_product_id
      ))::int AS resolved_valid_fk,
      COUNT(*) FILTER (WHERE metadata ? 'orbit_import_batch_id')::int AS orbit_import,
      COUNT(*) FILTER (WHERE evidence_status = 'complete')::int AS evidence_complete,
      COUNT(*) FILTER (WHERE evidence_status = 'missing')::int AS evidence_missing,
      COUNT(*) FILTER (WHERE evidence_status = 'partial')::int AS evidence_partial,
      COUNT(*) FILTER (WHERE source_row_id = ANY($2::uuid[]))::int AS fake_test_source_rows
    FROM claim_candidates
    WHERE organization_id = $1::uuid`,
    [orgId, FAKE_RETURN_IDS],
  );

  const ccByDim = await safeQuery(
    client,
    `SELECT source_kind, candidate_status, claim_family, COUNT(*)::int c
     FROM claim_candidates WHERE ${ccActiveFilter}
     GROUP BY 1,2,3 ORDER BY c DESC LIMIT 40`,
    [orgId],
  );

  const ccByStore = await safeQuery(
    client,
    `SELECT store_id, COUNT(*)::int c FROM claim_candidates WHERE ${ccActiveFilter}
     GROUP BY 1 ORDER BY c DESC`,
    [orgId],
  );

  const dupCandidates = await safeQuery(
    client,
    `SELECT source_table, source_row_id, claim_family, COUNT(*)::int c
     FROM claim_candidates WHERE ${ccActiveFilter}
     GROUP BY 1,2,3 HAVING COUNT(*) > 1 ORDER BY c DESC LIMIT 20`,
    [orgId],
  );

  let tridSummary: unknown = { skipped: "claim_reference_edges missing" };
  if (tableExistsMap.claim_reference_edges) {
    tridSummary = await safeQuery(
      client,
      hasCandidateIdOnEdges
        ? `SELECT
            COUNT(*)::int AS total_edges,
            COUNT(*) FILTER (WHERE candidate_id IS NOT NULL)::int AS candidate_anchored,
            COUNT(*) FILTER (WHERE draft_id IS NOT NULL)::int AS draft_anchored,
            COUNT(DISTINCT candidate_id) FILTER (WHERE candidate_id IS NOT NULL)::int AS distinct_candidates_with_edges,
            COUNT(*) FILTER (WHERE ambiguity_group_key IS NOT NULL AND btrim(ambiguity_group_key) <> '')::int AS ambiguity_edges,
            COUNT(DISTINCT ambiguity_group_key) FILTER (WHERE ambiguity_group_key IS NOT NULL)::int AS ambiguity_groups
          FROM claim_reference_edges WHERE organization_id = $1::uuid`
        : `SELECT COUNT(*)::int AS total_edges, COUNT(*) FILTER (WHERE draft_id IS NOT NULL)::int AS draft_anchored_only
           FROM claim_reference_edges WHERE organization_id = $1::uuid`,
      [orgId],
    );

    if (hasCandidateIdOnEdges) {
      const coverage = await safeQuery(
        client,
        `SELECT
          (SELECT COUNT(*)::int FROM claim_candidates WHERE ${ccActiveFilter}) AS active_candidates,
          (SELECT COUNT(DISTINCT candidate_id)::int FROM claim_reference_edges
            WHERE organization_id = $1 AND candidate_id IS NOT NULL) AS candidates_with_any_edge,
          (SELECT COUNT(*)::int FROM claim_candidates cc WHERE ${ccActiveFilter}
            AND EXISTS (SELECT 1 FROM claim_reference_edges e WHERE e.organization_id = cc.organization_id AND e.candidate_id = cc.id)
          ) AS active_with_materialized_edge`,
        [orgId],
      );
      (tridSummary as Record<string, unknown>).coverage = coverage;
    }
  }

  let evidenceSummary: unknown = { skipped: "claim_evidence missing" };
  if (tableExistsMap.claim_evidence) {
    evidenceSummary = await safeQuery(
      client,
      `SELECT
        COUNT(*)::int AS total_rows,
        COUNT(DISTINCT claim_case_id)::int AS cases_with_evidence,
        COUNT(*) FILTER (WHERE storage_path IS NOT NULL AND btrim(storage_path) <> '')::int AS with_storage_path,
        COUNT(*) FILTER (WHERE evidence_type IN ('photo','document'))::int AS photo_or_doc
      FROM claim_evidence WHERE organization_id = $1::uuid`,
      [orgId],
    );
  }

  const ccEvidenceField = await safeQuery(
    client,
    `SELECT evidence_status, COUNT(*)::int c FROM claim_candidates WHERE ${ccActiveFilter} GROUP BY 1 ORDER BY c DESC`,
    [orgId],
  );

  const casesSummary = tableExistsMap.claim_cases
    ? await safeQuery(client, `SELECT COUNT(*)::int c, COUNT(*) FILTER (WHERE status IS NOT NULL)::int with_status FROM claim_cases WHERE organization_id = $1::uuid`, [orgId])
    : { missing: true };

  const submissionsSummary = tableExistsMap.claim_submissions
    ? await safeQuery(
        client,
        `SELECT COUNT(*)::int total,
          COUNT(*) FILTER (WHERE return_id IS NOT NULL)::int with_return_link,
          COUNT(*) FILTER (WHERE status IN ('submitted','pending','investigating'))::int filed_like
        FROM claim_submissions WHERE organization_id = $1::uuid`,
        [orgId],
      )
    : { missing: true };

  let frrSummary: unknown = { skipped: true };
  if (tableExistsMap.financial_reference_resolver) {
    frrSummary = await safeQuery(
      client,
      `SELECT COUNT(*)::int total,
        COUNT(DISTINCT reference_kind)::int distinct_kinds,
        COUNT(*) FILTER (WHERE match_confidence IS NOT NULL)::int with_confidence
      FROM financial_reference_resolver WHERE organization_id = $1::uuid`,
      [orgId],
    );
  }

  let discoverySummary: unknown = { note: "stored in organization_settings.claim_policy.discovery_index JSON" };
  if (tableExistsMap.organization_settings) {
    discoverySummary = await safeQuery(
      client,
      `SELECT
        claim_policy->'discovery_index'->>'updated_at' AS discovery_updated_at,
        jsonb_object_keys(COALESCE(claim_policy->'discovery_index'->'sources', '{}'::jsonb)) AS source_key
      FROM organization_settings WHERE organization_id = $1::uuid`,
      [orgId],
    );
  }

  const pimMap = tableExistsMap.product_identifier_map
    ? await safeQuery(
        client,
        `SELECT COUNT(*)::int total,
          COUNT(*) FILTER (WHERE product_id IS NOT NULL)::int linked,
          COUNT(*) FILTER (WHERE confidence_score IS NOT NULL AND confidence_score < 0.7)::int low_confidence
        FROM product_identifier_map WHERE organization_id = $1::uuid`,
        [orgId],
      )
    : { missing: true };

  const staleCandidates = await safeQuery(
    client,
    `SELECT COUNT(*)::int c FROM claim_candidates
     WHERE ${ccActiveFilter}
       AND updated_at < now() - interval '90 days'`,
    [orgId],
  );

  await client.end();

  const activeDefault = Array.isArray(ccTotals) && ccTotals[0] ? (ccTotals[0] as { active_default: number }).active_default : 0;
  const withRecovery = Array.isArray(ccTotals) && ccTotals[0] ? (ccTotals[0] as { with_recovery_value: number }).with_recovery_value : 0;
  const resolvedValid = Array.isArray(ccTotals) && ccTotals[0] ? (ccTotals[0] as { resolved_valid_fk: number }).resolved_valid_fk : 0;
  const legacySeed = Array.isArray(ccTotals) && ccTotals[0] ? (ccTotals[0] as { legacy_seed: number }).legacy_seed : 0;

  const report = {
    run_id: runId,
    staging_ref: STAGING_REF,
    organization_id: orgId,
    table_exists: tableExistsMap,
    has_candidate_id_on_edges: hasCandidateIdOnEdges,
    real_data_inventory: {
      claim_candidates: ccTotals,
      by_source_status_family: ccByDim,
      by_store: ccByStore,
      duplicate_groups: dupCandidates,
    },
    candidate_quality_summary: ccTotals,
    trid_coverage_summary: tridSummary,
    product_linkage_summary: { claim_candidates: ccTotals, product_identifier_map: pimMap },
    evidence_coverage_summary: { claim_evidence_table: evidenceSummary, candidate_evidence_status: ccEvidenceField },
    cases_submissions_summary: { claim_cases: casesSummary, claim_submissions: submissionsSummary },
    recovery_data_summary: { financial_reference_resolver: frrSummary, recovery_value_on_candidates: withRecovery },
    source_run_summary: { discovery_index: discoverySummary, intake_run_ids: "via claim_candidates.intake_run_id" },
    fake_or_stale_data_risks: {
      legacy_seed_count: legacySeed,
      fake_test_source_row_links: Array.isArray(ccTotals) && ccTotals[0] ? (ccTotals[0] as { fake_test_source_rows: number }).fake_test_source_rows : null,
      stale_over_90d: staleCandidates,
    },
    SAFE_TO_IMPLEMENT_UI_ON_REAL_DATA: activeDefault > 0 && withRecovery > 0 ? "yes_with_warnings" : activeDefault > 0 ? "partial" : "no",
    NEXT_EXACT_PROMPT: "PHASE-CLAIM-CENTER-UI-DATA-CONTRACT-WIRE-STAGING",
  };

  fs.writeFileSync(path.join(outDir, "gate-report.json"), JSON.stringify(report, null, 2));

  const pageMatrix = buildPageMatrix(report, activeDefault, withRecovery, resolvedValid, hasCandidateIdOnEdges, tableExistsMap);
  fs.writeFileSync(path.join(outDir, "page-data-contract-matrix.json"), JSON.stringify(pageMatrix, null, 2));
  fs.writeFileSync(
    path.join(outDir, "audit-report.md"),
    renderMarkdown(report, pageMatrix, activeDefault, withRecovery, resolvedValid),
  );

  console.log(JSON.stringify({ ok: true, outDir, SAFE: report.SAFE_TO_IMPLEMENT_UI_ON_REAL_DATA, activeDefault }));
}

function buildPageMatrix(
  report: Record<string, unknown>,
  activeDefault: number,
  withRecovery: number,
  resolvedValid: number,
  hasCandidateEdges: boolean,
  tables: Record<string, boolean>,
) {
  const casesCount = extractCount(report, "cases_submissions_summary", "claim_cases", "c");
  const subsCount = extractCount(report, "cases_submissions_summary", "claim_submissions", "total");

  return [
    pageRow("Dashboard", "/claim-center", "/api/claims/center/dashboard", activeDefault > 0, activeDefault > 0 ? "primary" : "hidden", withRecovery === 0),
    pageRow("Opportunities", "/claim-center/opportunities", "/api/claims/center/opportunities", activeDefault > 0 && withRecovery > 0, withRecovery > 0 ? "primary" : "secondary", withRecovery === 0),
    pageRow("All candidates", "/claim-center/candidates", "/api/claims/inbox?view=center_v1", activeDefault > 0, activeDefault > 0 ? "primary" : "hidden", false),
    pageRow("Review queue", "/claim-center/candidates?filter=needs_review", "/api/claims/center/review", activeDefault > 0, "primary", true),
    pageRow("Evidence", "/claim-center/evidence", "/api/claims/center/review + /api/claims/inbox/[id]/evidence", activeDefault > 0, "secondary", true),
    pageRow("References/TRID", "/claim-center/references", "/api/claims/center/references", hasCandidateEdges && tables.claim_reference_edges, hasCandidateEdges ? "secondary" : "hidden", !hasCandidateEdges),
    pageRow("Product linkage", "/claim-center/product-linkage", "/api/claims/center/product-linkage", activeDefault > 0, resolvedValid < activeDefault * 0.5 ? "primary" : "secondary", true),
    pageRow("Recovery", "/claim-center/recovery", "/api/claims/center/recovery", activeDefault > 0, tables.financial_reference_resolver ? "secondary" : "hidden", !tables.financial_reference_resolver),
    pageRow("Source runs", "/claim-center/runs", "/api/claims/center/runs", tables.organization_settings, "secondary", true),
    pageRow("Cases", "/claim-center/cases", "/api/claims/center/cases", casesCount > 0, casesCount > 0 ? "secondary" : "not_built", true),
    pageRow("Submissions", "/claim-center/submissions", "/api/claims/center/submissions", subsCount > 0, subsCount > 0 ? "secondary" : "not_built", true),
    pageRow("Group builder", "/claim-center/group-builder", "TBD / candidates grouping", false, "hidden", true),
    pageRow("Policies", "/claim-center/policies", "settings read-only", true, "secondary", false),
  ];
}

function pageRow(
  page: string,
  route: string,
  api: string,
  realData: boolean,
  tier: string,
  mismatch: boolean,
) {
  return { page, route, api, real_data_available: realData, tier, mismatch, warning: mismatch ? "Show sample-cap banner; label derived fields" : null };
}

function extractCount(report: Record<string, unknown>, section: string, sub: string, field: string): number {
  const s = report[section] as Record<string, unknown> | undefined;
  const subObj = s?.[sub];
  if (Array.isArray(subObj) && subObj[0] && typeof subObj[0] === "object") return Number((subObj[0] as Record<string, unknown>)[field] ?? 0);
  if (subObj && typeof subObj === "object" && !Array.isArray(subObj)) return Number((subObj as Record<string, unknown>)[field] ?? 0);
  return 0;
}

function renderMarkdown(
  report: Record<string, unknown>,
  matrix: ReturnType<typeof buildPageMatrix>,
  active: number,
  recovery: number,
  resolved: number,
): string {
  return `# Claim Center Real Data Contract Audit

**Run:** ${report.run_id} | **Org:** ${report.organization_id} | **Staging:** ${report.staging_ref}

## Summary

- Active candidates (default filter): **${active}**
- With recovery_value: **${recovery}**
- Valid resolved_product_id FK: **${resolved}**

## SAFE_TO_IMPLEMENT_UI_ON_REAL_DATA: **${report.SAFE_TO_IMPLEMENT_UI_ON_REAL_DATA}**

## Pages

${matrix.map((p) => `- **${p.page}** (${p.tier}): real=${p.real_data_available}${p.warning ? ` — ${p.warning}` : ""}`).join("\n")}

## NEXT: ${report.NEXT_EXACT_PROMPT}
`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
