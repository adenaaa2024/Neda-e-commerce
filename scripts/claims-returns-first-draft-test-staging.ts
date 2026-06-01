/**
 * Post-config draft smoke: pick first draft-eligible physical return_item and optionally create draft.
 *
 *   npx tsx scripts/claims-returns-first-draft-test-staging.ts [--create-draft] [--run-id=<UTC>]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Module } from "node:module";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";

import { loadClaimPolicy } from "../lib/claim-eligibility-policy";
import {
  buildReturnsClaimQueueRow,
  isPhysicalReturnItemForClaims,
  packageStatusIsClosed,
  returnItemHasScannerClaimIssue,
} from "../lib/returns-claims-work-queue";
import {
  evaluateManualDraftEligibility,
  evaluateManualDraftPolicyGate,
  isBlockedGrainForManualDraftCreation,
} from "../lib/returns-manual-claim-grouping";
import { loadEnvLocalIntoProcess, getStagingProjectRef } from "../lib/staging-project-ref";

require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const OUT_BASE = ".cursor/audit-reports/claims-returns-first-configure-staging";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function main(): Promise<void> {
  const createDraft = process.argv.includes("--create-draft");
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const stagingUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const serviceKey = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const autoPromote =
    process.env.CLAIM_SCANNER_AUTO_PROMOTE_ENABLED?.trim().toLowerCase() === "1" ||
    process.env.CLAIM_SCANNER_AUTO_PROMOTE_ENABLED?.trim().toLowerCase() === "true";

  if (getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) throw new Error("staging ref guard");

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const rows = (
    await client.query(`
      SELECT ri.id::text AS return_item_id, ri.organization_id::text, ri.store_id::text,
             ri.package_id::text, ri.pallet_id::text, ri.expected_item_id::text,
             ri.conditions, ri.photo_evidence, ri.notes, ri.resolved_product_id::text,
             ri.created_at::text, pkg.status AS package_status
      FROM return_items ri
      LEFT JOIN packages pkg ON pkg.id = ri.package_id
      WHERE ri.deleted_at IS NULL AND ri.organization_id = $1 AND ri.package_id IS NOT NULL
      ORDER BY ri.created_at DESC
      LIMIT 80
    `, [ORG])
  ).rows;

  await client.end();

  const sb = createClient(stagingUrl, serviceKey, { auth: { persistSession: false } });
  const policy = await loadClaimPolicy(sb, ORG);

  type Pick = (typeof rows)[0] & { draft_allowed: boolean; draft_reason: string; package_closed: boolean };
  const evaluated: Pick[] = [];

  for (const row of rows) {
    const packageClosed = packageStatusIsClosed(row.package_status);
    const input = {
      return_item_id: row.return_item_id,
      organization_id: row.organization_id,
      store_id: row.store_id,
      package_id: row.package_id,
      pallet_id: row.pallet_id,
      expected_item_id: row.expected_item_id,
      conditions: row.conditions,
      photo_evidence: row.photo_evidence,
      notes: row.notes,
      resolved_product_id: row.resolved_product_id,
      created_at: row.created_at,
    };
    const queueRow = buildReturnsClaimQueueRow(
      {
        return_item_id: row.return_item_id,
        organization_id: row.organization_id,
        store_id: row.store_id,
        package_id: row.package_id,
        pallet_id: row.pallet_id,
        expected_item_id: row.expected_item_id,
        created_at: row.created_at,
        conditions: row.conditions,
        photo_evidence: row.photo_evidence,
        notes: row.notes,
        resolved_product_id: row.resolved_product_id,
        resolved_catalog_product_id: null,
        identifier_resolution_status: null,
        order_id: null,
        sku: null,
        fnsku: null,
        asin: null,
        item_name: null,
        lpn: null,
        status: null,
        claim_line: null,
      },
      policy,
      packageClosed,
    );
    const draftElig = evaluateManualDraftEligibility(queueRow, policy);
    const gate = evaluateManualDraftPolicyGate(input, policy, {
      packageClosedByReturnItemId: { [row.return_item_id]: packageClosed },
    });
    evaluated.push({
      ...row,
      draft_allowed: draftElig.allowed && gate.allowed,
      draft_reason: draftElig.allowed ? gate.reason : draftElig.reason,
      package_closed: packageClosed,
    });
  }

  const eligible = evaluated.filter(
    (r) =>
      isPhysicalReturnItemForClaims({
        package_id: r.package_id,
        pallet_id: r.pallet_id,
        expected_item_id: r.expected_item_id,
      }) &&
      returnItemHasScannerClaimIssue(r.conditions) &&
      r.draft_allowed,
  );

  let draftResult: Record<string, unknown> = { ok: false, skipped: true, reason: "no_eligible_candidate" };
  let createdClaimCaseId: string | null = null;
  const blockedGrains: string[] = [];

  if (createDraft && eligible[0]) {
    const pick = eligible[0];
    const { createManualReturnsClaimDraft } = await import(
      "../app/returns/returns-manual-claim-grouping-actions"
    );
    draftResult = await createManualReturnsClaimDraft([pick.return_item_id], {
      grouping_dimension: "issue",
      tenant: { actorProfileId: null, filterOrganizationId: ORG },
    });
    if ((draftResult as { ok?: boolean }).ok && (draftResult as { claim_case_id?: string }).claim_case_id) {
      createdClaimCaseId = (draftResult as { claim_case_id: string }).claim_case_id;
      const { data: lines } = await sb
        .from("claim_lines")
        .select("id, line_grain, source_table, return_item_id")
        .eq("claim_case_id", createdClaimCaseId);
      for (const l of lines ?? []) {
        const grain = String((l as { line_grain: string }).line_grain);
        const st = String((l as { source_table?: string }).source_table ?? "");
        if (isBlockedGrainForManualDraftCreation(grain, st)) blockedGrains.push(grain);
      }
      draftResult = { ...draftResult, claim_lines: lines, blocked_grains_attached: blockedGrains };
    }
  } else if (createDraft) {
    draftResult = {
      ok: false,
      skipped: true,
      reason: "no_draft_eligible_physical_return_item",
      evaluated_count: evaluated.length,
      sample_blockers: evaluated.slice(0, 5).map((r) => ({
        id: r.return_item_id,
        draft_reason: r.draft_reason,
        package_closed: r.package_closed,
        conditions: r.conditions,
      })),
    };
  }

  const manifest = {
    run_id: runId,
    create_draft: createDraft,
    eligible_count: eligible.length,
    picked_return_item_id: eligible[0]?.return_item_id ?? null,
    draft_test_result: draftResult,
    created_claim_case_id: createdClaimCaseId,
    auto_promote_enabled: autoPromote,
    blocked_grains_attached: blockedGrains,
    only_return_item_grain:
      blockedGrains.length === 0 &&
      ((draftResult as { claim_lines?: { line_grain: string }[] }).claim_lines ?? []).every(
        (l) => l.line_grain === "return_item",
      ),
    SAFE_TO_CONTINUE:
      !autoPromote &&
      eligible.length > 0 &&
      (createDraft ? (draftResult as { ok?: boolean }).ok === true && blockedGrains.length === 0 : true)
        ? "yes"
        : createDraft && eligible.length === 0
          ? "no_eligible_candidate"
          : "no",
  };

  fs.writeFileSync(path.join(outDir, "draft-test-manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
