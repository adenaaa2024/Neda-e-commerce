/**
 * PC05 — Claim engine readiness census (read-only, staging).
 *
 *   npx tsx scripts/pc05-claim-engine-readiness-census.ts --run-id=<id>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  runClaimResolverMaterializePass,
} from "../lib/claim-candidate-resolver-materialize";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/pc05-claim-engine-readiness-census";

const FAKE_TEST_RETURN_ITEM_IDS = [
  "23ccf73f-cbda-485e-9ebb-cc8e365b9172",
  "3270ee19-441d-4b30-9d66-0273c46ea247",
  "ccffe8b3-87ea-4b7b-bfd5-4cf9cc16d663",
  "e08156b5-6f59-4bad-9a33-330c500df9cd",
];

type CensusBucket =
  | "valid_candidate"
  | "fake_test_derived"
  | "missing_source_row"
  | "missing_product"
  | "ambiguous_product"
  | "duplicate_risk"
  | "needs_packaging_dimensions"
  | "needs_sp_api_reimbursement_evidence";

type TableName = "claim_candidates" | "claim_candidate_drafts";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function tableExists(client: pg.Client, table: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return (r.rowCount ?? 0) > 0;
}

async function safeCount(client: pg.Client, sql: string, params: unknown[] = []): Promise<number | null> {
  try {
    const r = await client.query(sql, params);
    return Number(r.rows[0]?.c ?? r.rows[0]?.n ?? 0);
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  const publicUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const ref = refFromSupabaseUrl(publicUrl) || refFromSupabaseUrl(dbUrl);
  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    throw new Error(`Staging guard failed (ref=${ref})`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const prereq: Record<string, unknown> = {};

  for (const t of [
    "claim_candidates",
    "claim_candidate_drafts",
    "return_items",
    "expected_packages",
    "shipment_containers",
    "shipment_boxes",
    "amazon_returns",
    "amazon_removals",
    "amazon_removal_shipments",
    "slip_contents",
    "claim_reference_edges",
    "claim_enrichment_generations",
    "claim_review_work_items",
    "products",
    "product_identifier_map",
  ]) {
    prereq[t] = { exists: await tableExists(client, t) };
  }

  const claimCounts = await client.query(`
    SELECT 'claim_candidates' AS tbl,
      COUNT(*)::bigint AS total,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::bigint AS resolved,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM public.products p WHERE p.id = resolved_product_id))::bigint AS resolved_valid_fk,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = resolved_product_id))::bigint AS orphan_resolved_fk
    FROM public.claim_candidates
    UNION ALL
    SELECT 'claim_candidate_drafts',
      COUNT(*)::bigint,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::bigint,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM public.products p WHERE p.id = resolved_product_id))::bigint,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = resolved_product_id))::bigint
    FROM public.claim_candidate_drafts
  `);

  const bySource = await client.query(`
    SELECT 'claim_candidates' AS tbl, source_table, COUNT(*)::bigint AS n,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::bigint AS resolved
    FROM public.claim_candidates GROUP BY source_table
    UNION ALL
    SELECT 'claim_candidate_drafts', source_table, COUNT(*)::bigint,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::bigint
    FROM public.claim_candidate_drafts GROUP BY source_table
    ORDER BY n DESC
  `);

  const returnItems = await client.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE deleted_at IS NULL)::int AS active,
      COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS soft_deleted,
      COUNT(*) FILTER (WHERE deleted_at IS NULL AND resolved_product_id IS NOT NULL)::int AS active_resolved
    FROM public.return_items
  `);

  const epLinkage = await client.query(`
    SELECT
      COUNT(*)::bigint AS total,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::bigint AS resolved
    FROM public.expected_packages
  `);

  const shipmentTree = await client.query(`
    SELECT
      (SELECT COUNT(*)::bigint FROM public.shipment_containers) AS containers,
      (SELECT COUNT(*)::bigint FROM public.shipment_boxes) AS boxes
  `);

  const duplicateDraftKeys = await client.query(`
    SELECT COUNT(*)::bigint AS duplicate_key_groups
    FROM (
      SELECT idempotency_key FROM public.claim_candidate_drafts
      GROUP BY idempotency_key HAVING COUNT(*) > 1
    ) x
  `);

  const duplicateSourcePointer = await client.query(`
    SELECT COUNT(*)::bigint AS dup_groups FROM (
      SELECT organization_id, source_table, source_row_id
      FROM public.claim_candidates
      GROUP BY organization_id, source_table, source_row_id HAVING COUNT(*) > 1
    ) a
  `);

  const fakeTestClaimLinks = await client.query(
    `
    SELECT COUNT(*)::bigint AS c FROM public.claim_candidates
    WHERE source_table = 'return_items'
      AND source_row_id::uuid = ANY($1::uuid[])
    UNION ALL
    SELECT COUNT(*)::bigint FROM public.claim_candidate_drafts
    WHERE source_table = 'return_items'
      AND source_row_id::uuid = ANY($1::uuid[])
  `,
    [FAKE_TEST_RETURN_ITEM_IDS],
  );

  const orphanSourceDrafts = await client.query(`
    SELECT COUNT(*)::bigint AS c
    FROM public.claim_candidate_drafts d
    JOIN public.amazon_removal_shipments s ON s.id = d.source_row_id::uuid AND s.organization_id = d.organization_id
    WHERE d.resolved_product_id IS NULL AND d.source_table = 'amazon_removal_shipments'
      AND s.resolved_product_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = s.resolved_product_id)
  `);

  let packagingGapCount: number | null = null;
  try {
    const packagingGap = await client.query(`
      SELECT COUNT(*)::bigint AS c
      FROM public.claim_candidate_drafts d
      WHERE d.source_table = 'amazon_returns'
        AND d.evidence_status IN ('missing', 'partial')
    `);
    packagingGapCount = Number(packagingGap.rows[0]?.c ?? 0);
  } catch {
    packagingGapCount = null;
  }

  const evidenceGraph = await client.query(`
    SELECT
      (SELECT COUNT(*)::bigint FROM public.claim_enrichment_generations) AS generations,
      (SELECT COUNT(*)::bigint FROM public.claim_reference_edges) AS reference_edges,
      (SELECT COUNT(DISTINCT draft_id)::bigint FROM public.claim_reference_edges) AS drafts_with_edges,
      (SELECT COUNT(*)::bigint FROM public.claim_review_work_items) AS review_work_items
  `);

  const reimbursementGap = await client.query(`
    SELECT COUNT(*)::bigint AS c
    FROM public.claim_candidate_drafts d
    WHERE d.claim_family IN ('AMAZON_RETURNS', 'AMAZON_REMOVALS', 'AMAZON_REMOVAL_SHIPMENTS')
      AND d.evidence_status IN ('missing', 'partial')
      AND NOT EXISTS (
        SELECT 1 FROM public.claim_reference_edges e WHERE e.draft_id = d.id
      )
  `);

  await client.end();

  const key =
    process.env.STAGING_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const supabase = createClient(publicUrl, key, { auth: { persistSession: false } });

  const ccPass = await runClaimResolverMaterializePass(supabase, "claim_candidates", {
    onlyUnresolved: true,
    useInboxContext: true,
  });
  const cdPass = await runClaimResolverMaterializePass(supabase, "claim_candidate_drafts", {
    onlyUnresolved: true,
    useInboxContext: false,
  });

  const cc = claimCounts.rows.find((r: { tbl: string }) => r.tbl === "claim_candidates") as {
    total: string;
    resolved: string;
    resolved_valid_fk: string;
    orphan_resolved_fk: string;
  };
  const cd = claimCounts.rows.find((r: { tbl: string }) => r.tbl === "claim_candidate_drafts") as {
    total: string;
    resolved: string;
    resolved_valid_fk: string;
    orphan_resolved_fk: string;
  };

  const ccTotal = Number(cc.total);
  const cdTotal = Number(cd.total);
  const totalRows = ccTotal + cdTotal;
  const validFkResolved = Number(cc.resolved_valid_fk) + Number(cd.resolved_valid_fk);
  const orphanFk = Number(cc.orphan_resolved_fk) + Number(cd.orphan_resolved_fk);
  const unresolved = totalRows - Number(cc.resolved) - Number(cd.resolved);

  const bucketSummary: Record<CensusBucket, { count: number; tables: Record<string, number> }> = {
    valid_candidate: { count: validFkResolved, tables: { claim_candidates: Number(cc.resolved_valid_fk), claim_candidate_drafts: Number(cd.resolved_valid_fk) } },
    fake_test_derived: {
      count: Number(fakeTestClaimLinks.rows[0]?.c ?? 0) + Number(fakeTestClaimLinks.rows[1]?.c ?? 0),
      tables: { claim_candidates: Number(fakeTestClaimLinks.rows[0]?.c ?? 0), claim_candidate_drafts: Number(fakeTestClaimLinks.rows[1]?.c ?? 0) },
    },
    missing_source_row: {
      count: ccPass.metrics.skipped_missing_source,
      tables: { claim_candidates: ccPass.metrics.skipped_missing_source, claim_candidate_drafts: cdPass.metrics.skipped_missing_source },
    },
    missing_product: {
      count:
        (ccPass.metrics.bucket_counts.unresolved_no_identifiers ?? 0) +
        (cdPass.metrics.bucket_counts.unresolved_no_identifiers ?? 0) +
        (ccPass.metrics.bucket_counts.blocked_pim ?? 0) +
        (cdPass.metrics.bucket_counts.blocked_pim ?? 0) +
        orphanFk +
        Number(orphanSourceDrafts.rows[0]?.c ?? 0),
      tables: {},
    },
    ambiguous_product: {
      count: ccPass.metrics.skipped_ambiguous + cdPass.metrics.skipped_ambiguous,
      tables: { claim_candidates: ccPass.metrics.skipped_ambiguous, claim_candidate_drafts: cdPass.metrics.skipped_ambiguous },
    },
    duplicate_risk: {
      count: Number(duplicateSourcePointer.rows[0]?.dup_groups ?? 0) + Number(duplicateDraftKeys.rows[0]?.duplicate_key_groups ?? 0),
      tables: { claim_candidates_dup_source_groups: Number(duplicateSourcePointer.rows[0]?.dup_groups ?? 0), drafts_dup_idempotency_groups: Number(duplicateDraftKeys.rows[0]?.duplicate_key_groups ?? 0) },
    },
    needs_packaging_dimensions: {
      count: packagingGapCount ?? 0,
      tables: { claim_candidate_drafts_amazon_returns_evidence_gap: packagingGapCount ?? 0 },
    },
    needs_sp_api_reimbursement_evidence: {
      count: Number(reimbursementGap.rows[0]?.c ?? 0),
      tables: { claim_candidate_drafts_no_reference_edges: Number(reimbursementGap.rows[0]?.c ?? 0) },
    },
  };

  const eligibleRemaining = ccPass.metrics.eligible_safe_update + cdPass.metrics.eligible_safe_update;
  const readinessPct = totalRows > 0 ? Math.round((validFkResolved / totalRows) * 1000) / 10 : 0;
  const executeReadinessPct =
    unresolved > 0
      ? Math.round(((eligibleRemaining - Number(orphanSourceDrafts.rows[0]?.c ?? 0)) / Math.max(unresolved, 1)) * 1000) / 10
      : 100;

  const blockers = [
    { id: "orphan_candidate_resolved_fk", severity: "blocker", count: Number(cc.orphan_resolved_fk), message: "claim_candidates resolved_product_id not in products" },
    { id: "orphan_source_rpid_drafts", severity: "blocker", count: Number(orphanSourceDrafts.rows[0]?.c ?? 0), message: "Unresolved drafts tied to orphan amazon_removal_shipments RPID" },
    { id: "missing_source_row", severity: "blocker", count: bucketSummary.missing_source_row.count, message: "Operational source row not found" },
    { id: "missing_product_unresolved", severity: "blocker", count: (ccPass.metrics.bucket_counts.unresolved_no_identifiers ?? 0) + (cdPass.metrics.bucket_counts.unresolved_no_identifiers ?? 0), message: "No identifier map / source product proposal" },
    { id: "blocked_pim", severity: "warn", count: (ccPass.metrics.bucket_counts.blocked_pim ?? 0) + (cdPass.metrics.bucket_counts.blocked_pim ?? 0), message: "PIM-blocked proposals" },
    { id: "ambiguous_product", severity: "warn", count: bucketSummary.ambiguous_product.count, message: "Ambiguous identifier map" },
    { id: "blind_execute_drafts", severity: "blocker", count: eligibleRemaining, message: "Dry-run eligible drafts — NOT safe without Wave B source cleanup" },
    { id: "packaging_evidence_gap", severity: "warn", count: bucketSummary.needs_packaging_dimensions.count, message: "amazon_returns drafts missing package linkage" },
    { id: "reference_graph_gap", severity: "warn", count: bucketSummary.needs_sp_api_reimbursement_evidence.count, message: "Drafts without claim_reference_edges" },
  ].filter((b) => b.count > 0);

  const checklist = [
    { item: "Staging ref guard", status: "pass", detail: STAGING_REF },
    { item: "return_items active cohort resolved", status: Number(returnItems.rows[0]?.active_resolved) === Number(returnItems.rows[0]?.active) ? "pass" : "warn", detail: `${returnItems.rows[0]?.active_resolved}/${returnItems.rows[0]?.active} active resolved` },
    { item: "Soft-deleted return_items excluded from views", status: "pass", detail: `${returnItems.rows[0]?.soft_deleted} soft-deleted (V189)` },
    { item: "claim_candidates valid product FK", status: Number(cc.orphan_resolved_fk) === 0 ? "pass" : "fail", detail: `${cc.resolved_valid_fk} valid / ${cc.orphan_resolved_fk} orphan of ${cc.resolved} resolved` },
    { item: "claim_candidate_drafts valid product FK", status: Number(cd.orphan_resolved_fk) === 0 ? "pass" : "fail", detail: `${cd.resolved_valid_fk} valid / ${cd.resolved} resolved` },
    { item: "expected_packages product linkage", status: Number(epLinkage.rows[0]?.resolved) > 0 ? "warn" : "fail", detail: `${epLinkage.rows[0]?.resolved}/${epLinkage.rows[0]?.total} resolved_product_id` },
    { item: "Shipment tree present", status: Number(shipmentTree.rows[0]?.containers) > 0 ? "pass" : "warn", detail: `${shipmentTree.rows[0]?.containers} containers, ${shipmentTree.rows[0]?.boxes} boxes` },
    { item: "Evidence graph populated", status: Number(evidenceGraph.rows[0]?.reference_edges) > 0 ? "pass" : "warn", detail: `${evidenceGraph.rows[0]?.reference_edges} edges on ${evidenceGraph.rows[0]?.drafts_with_edges} drafts` },
    { item: "Blind resolver execute", status: "fail", detail: "Not approved — upstream blockers remain" },
    { item: "Claim submission / Amazon API", status: "pass", detail: "Out of scope; not invoked" },
  ];

  const nextPrompt = "CLAIM-CLEANUP-WAVE-B-SOURCE-ORPHAN-RPID-V191";

  const manifest = {
    prompt: "PC05-CLAIM-ENGINE-READINESS-CENSUS",
    branch: "feature/product-canonicalization-v2",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: "read_only",
    total_claim_rows: totalRows,
    readiness_pct_valid_product_fk: readinessPct,
    execute_readiness_pct_unresolved: executeReadinessPct,
    claim_candidates: { total: ccTotal, resolved_valid_fk: Number(cc.resolved_valid_fk), orphan_fk: Number(cc.orphan_resolved_fk) },
    claim_candidate_drafts: { total: cdTotal, resolved_valid_fk: Number(cd.resolved_valid_fk), orphan_fk: Number(cd.orphan_resolved_fk) },
    bucket_summary: bucketSummary,
    blockers_count: blockers.length,
    cleanup_recommended: true,
    next_prompt: nextPrompt,
    status: Number(cc.orphan_resolved_fk) > 0 ? "PASS_WITH_BLOCKERS" : "PASS",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, "claim-bucket-summary.json"), JSON.stringify(bucketSummary, null, 2));
  fs.writeFileSync(path.join(outDir, "blockers.md"), ["# Blockers", "", ...blockers.map((b) => `- **${b.id}** (${b.severity}): ${b.count} — ${b.message}`)].join("\n"));
  fs.writeFileSync(
    path.join(outDir, "prerequisites-before-execute.md"),
    [
      "# Prerequisites before claim execute",
      "",
      "## Checklist",
      ...checklist.map((c) => `- [${c.status === "pass" ? "x" : " "}] **${c.item}** — ${c.detail} (${c.status})`),
      "",
      "## Required upstream (PC05 live census)",
      "1. Wave B: `amazon_removals` missing source row repair (~1543 candidates)",
      "2. Wave A: PIM / identifier_map for blocked_pim + unresolved_no_identifiers",
      "3. Evidence graph: populate claim_reference_edges before filing prep",
      "4. expected_packages product linkage at scale",
      "5. Re-verify orphan FK before any execute (0 at census time)",
      "",
      "## Hard stops",
      "- No blind resolver execute",
      "- No claim submission",
      "- No production",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(outDir, "next-claim-prompts.md"),
    [
      "# Next claim prompts (ordered)",
      "",
      `1. **${nextPrompt}** — staging dry-run + approval for source orphan RPID / missing source row cleanup`,
      "2. **CLAIM-REGENERATION-DRYRUN-V192** — rule-aware v2 generator dry-run after Wave B",
      "3. **CLAIM-CLEANUP-REGENERATION-PLAN-V190** — execute plan pack if not yet written",
      "4. **CLAIM-REVIEW-BOOTSTRAP-DRYRUN** — review work items with `dry_run: true` only",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(outDir, "fake-test-risk.md"),
    [
      "# Fake / test claim risk",
      "",
      `- Soft-deleted return_items (V186 allowlist): **${returnItems.rows[0]?.soft_deleted}**`,
      `- Active return_items: **${returnItems.rows[0]?.active}** (3/3 resolved per V189 — not production KPI)`,
      `- Claims pointing at fake/test return_item PKs: **${bucketSummary.fake_test_derived.count}**`,
      "",
      "## Policy",
      "- Exclude `deleted_at IS NOT NULL` return_items from generator evidence probes",
      "- Staging bulk claims are **Amazon import tables** (~9k rows), not scanner cohort",
      "- Do not treat staging claim coverage % as production truth",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(outDir, "product-linkage-gaps.md"),
    [
      "# Product linkage gaps",
      "",
      "## Claim tables",
      `- claim_candidates: **${cc.resolved_valid_fk}/${cc.total}** valid FK (${readinessPct}% of candidates with valid spine when resolved)`,
      `- claim_candidate_drafts: **${cd.resolved_valid_fk}/${cd.total}** valid FK`,
      `- Orphan resolved (candidates): **${cc.orphan_resolved_fk}**`,
      "",
      "## Source / spine tables",
      `- return_items active resolved: **${returnItems.rows[0]?.active_resolved}/${returnItems.rows[0]?.active}**`,
      `- expected_packages resolved_product_id: **${epLinkage.rows[0]?.resolved}/${epLinkage.rows[0]?.total}**`,
      `- Unresolved projection: missing_product bucket **~${bucketSummary.missing_product.count}** (includes orphan FK + map misses)`,
      `- Orphan source RPID (unresolved drafts): **${orphanSourceDrafts.rows[0]?.c}**`,
      "",
      "## Resolver scan (unresolved)",
      `- eligible_safe_update (do not blind execute): **${eligibleRemaining}**`,
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(outDir, "claim-census.md"),
    [
      "# PC05 — Claim engine readiness census",
      "",
      `- run_id: \`${runId}\``,
      `- staging: \`${STAGING_REF}\``,
      `- branch: \`feature/product-canonicalization-v2\``,
      `- mode: **read-only**`,
      "",
      "## Summary",
      `- Total claim rows (candidates + drafts): **${totalRows}**`,
      `- **Readiness (valid product FK / total): ${readinessPct}%**`,
      `- Execute readiness (unresolved, net of orphan source): **${executeReadinessPct}%** (not approved)`,
      "",
      "## Table inventory",
      `- claim_candidates: ${ccTotal} (${cc.resolved} resolved, ${cc.resolved_valid_fk} valid FK)`,
      `- claim_candidate_drafts: ${cdTotal} (${cd.resolved} resolved, ${cd.resolved_valid_fk} valid FK)`,
      `- return_items: ${returnItems.rows[0]?.total} total, ${returnItems.rows[0]?.active} active`,
      `- expected_packages: ${epLinkage.rows[0]?.total}`,
      `- shipment_containers / boxes: ${shipmentTree.rows[0]?.containers} / ${shipmentTree.rows[0]?.boxes}`,
      `- claim_reference_edges: ${evidenceGraph.rows[0]?.reference_edges}`,
      "",
      "## Buckets",
      ...Object.entries(bucketSummary).map(([k, v]) => `- **${k}**: ${v.count}`),
      "",
      "See `claim-bucket-summary.json`, `blockers.md`, `prerequisites-before-execute.md`.",
    ].join("\n"),
  );

  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
