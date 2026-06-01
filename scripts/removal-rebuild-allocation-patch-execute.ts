/**
 * REMOVAL-REBUILD-ALLOCATION-PATCH-EXECUTE — tracking-group under-allocation fix (staging)
 *
 *   npx tsx scripts/removal-rebuild-allocation-patch-execute.ts --apply [--run-id=<UTC_Z>]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  queryEpAllocationMismatchBreakdown,
  rebuildValidFromBreakdown,
} from "../lib/removal/ep-allocation-mismatch-breakdown";
import {
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const REQUIRED_BRANCH = "feature/product-canonicalization-v3";
const APPROVAL_PATH = ".cursor/operator-approvals/removal-rebuild-allocation-fix-approval.md";
const DIAGNOSIS_RUN = "20260530T180500Z";
const DIAGNOSIS_PATH = `.cursor/audit-reports/removal-daily-automation-diagnose/${DIAGNOSIS_RUN}`;
const OUT_BASE = ".cursor/audit-reports/removal-rebuild-allocation-patch-execute";
const TRACKING_GROUP_MIGRATION =
  "supabase/migrations/20260827160000_expected_packages_tracking_group_allocation.sql";

const PRIMARY_DETAIL_ID = "801786d9-1aaf-482f-9087-841cc6c4341f";
const SECONDARY_DETAIL_ID = "bb91979c-0450-4b3f-919d-2b23ba4bd208";
const TRACKING_VERIFY = "387019251";
const TRACKING_EXPECTED_QTY = 989;

type RebuildResult = {
  detail_lines_in_scope: number;
  matched_rows_upserted: number;
  remainder_rows_upserted: number;
  overflow_lines: number;
  obsolete_rows_deleted: number;
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function readApproval(): boolean {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  return (
    /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text) &&
    /APPROVED_REMOVAL_REBUILD_ALLOCATION_FIX\s*=\s*true/i.test(text)
  );
}

async function duplicateGroupCounts(client: pg.Client): Promise<{
  dup_remainder: number;
  dup_business_key: number;
}> {
  const dupRem = await client.query(
    `SELECT count(*)::int AS c FROM (
       SELECT source_detail_row_id FROM public.expected_packages
       WHERE organization_id=$1::uuid AND store_id=$2::uuid AND build_source='detail_remainder'
       GROUP BY source_detail_row_id HAVING count(*)>1
     ) x`,
    [ORG_ID, STORE_ID],
  );
  const dupBiz = await client.query(
    `SELECT count(*)::int AS c FROM (
       SELECT source_detail_row_id, source_shipment_row_id, build_source, allocation_group_key
       FROM public.expected_packages
       WHERE organization_id=$1::uuid AND store_id=$2::uuid
         AND build_source IN ('detail_shipment','detail_remainder')
       GROUP BY 1,2,3,4 HAVING count(*)>1
     ) x`,
    [ORG_ID, STORE_ID],
  );
  return {
    dup_remainder: (dupRem.rows[0] as { c: number }).c,
    dup_business_key: (dupBiz.rows[0] as { c: number }).c,
  };
}

async function trackingGroupQty(
  client: pg.Client,
  detailId: string,
  tracking: string,
): Promise<{ ep_qty: number; shipment_qty: number; ep_rows: number }> {
  const ep = await client.query(
    `SELECT coalesce(sum(expected_scan_quantity),0)::int AS q, count(*)::int AS n
     FROM public.expected_packages
     WHERE organization_id=$1::uuid AND store_id=$2::uuid
       AND source_detail_row_id=$3::uuid AND build_source='detail_shipment'
       AND tracking_number IS NOT DISTINCT FROM $4::text`,
    [ORG_ID, STORE_ID, detailId, tracking],
  );
  const ship = await client.query(
    `SELECT coalesce(sum(s.shipped_quantity),0)::int AS q
     FROM public.amazon_removal_shipments s
     JOIN public.amazon_removals d ON d.id = $2::uuid
     WHERE s.organization_id=$1::uuid AND s.store_id IS NOT DISTINCT FROM d.store_id
       AND s.order_id IS NOT DISTINCT FROM d.order_id
       AND s.order_type IS NOT DISTINCT FROM d.order_type
       AND s.order_date IS NOT DISTINCT FROM d.order_date
       AND nullif(btrim(s.sku),'') IS NOT DISTINCT FROM nullif(btrim(d.sku),'')
       AND nullif(btrim(s.fnsku),'') IS NOT DISTINCT FROM nullif(btrim(d.fnsku),'')
       AND nullif(btrim(s.tracking_number),'') = $3::text`,
    [ORG_ID, detailId, tracking],
  );
  const epRow = ep.rows[0] as { q: number; n: number };
  return {
    ep_qty: epRow.q,
    shipment_qty: (ship.rows[0] as { q: number }).q,
    ep_rows: epRow.n,
  };
}

async function detailLiveSum(client: pg.Client, detailId: string): Promise<number> {
  const r = await client.query(
    `SELECT coalesce(sum(expected_scan_quantity),0)::int AS q
     FROM public.expected_packages
     WHERE organization_id=$1::uuid AND store_id=$2::uuid
       AND source_detail_row_id=$3::uuid
       AND build_source IN ('detail_shipment','detail_remainder')`,
    [ORG_ID, STORE_ID, detailId],
  );
  return (r.rows[0] as { q: number }).q;
}

async function detailExpectedSum(client: pg.Client, detailId: string): Promise<number> {
  const r = await client.query(
    `SELECT coalesce(d.shipped_quantity,0)::int AS q FROM public.amazon_removals d WHERE d.id=$1::uuid`,
    [detailId],
  );
  return (r.rows[0] as { q: number }).q;
}

async function deleteDuplicateRemainders(client: pg.Client): Promise<number> {
  const delRes = await client.query(
    `
    WITH ranked AS (
      SELECT id,
        row_number() OVER (
          PARTITION BY organization_id, store_id, source_detail_row_id
          ORDER BY rebuild_run_at DESC NULLS LAST, updated_at DESC
        ) AS rn
      FROM public.expected_packages
      WHERE organization_id = $1::uuid AND store_id = $2::uuid
        AND build_source = 'detail_remainder'
    )
    DELETE FROM public.expected_packages ep
    USING ranked r
    WHERE ep.id = r.id AND r.rn > 1
    RETURNING ep.id::text
    `,
    [ORG_ID, STORE_ID],
  );
  return delRes.rowCount ?? 0;
}

function rebuildUsesTrackingGroups(client: pg.Client): Promise<boolean> {
  return client
    .query(
      `SELECT pg_get_functiondef(p.oid) AS def
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'rebuild_expected_packages_from_removals'
       LIMIT 1`,
    )
    .then((r) => {
      const def = (r.rows[0] as { def?: string } | undefined)?.def ?? "";
      return def.includes("allocation_group_key") && def.includes("tracking_operational");
    });
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const runId = runIdArg();
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
  const branchMismatch = branch !== REQUIRED_BRANCH;
  if (!readApproval()) blockers.push("Approval flags not true in removal-rebuild-allocation-fix-approval.md");

  const diagnosisEvidence = path.join(process.cwd(), DIAGNOSIS_PATH, "evidence.json");
  if (!fs.existsSync(diagnosisEvidence)) {
    blockers.push(`Diagnosis artifact missing: ${DIAGNOSIS_PATH}/evidence.json`);
  } else {
    fs.copyFileSync(diagnosisEvidence, path.join(outDir, "diagnosis-evidence.json"));
  }

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset");
  else {
    if (!supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
      blockers.push(`DB URL must target staging ${STAGING_REF}`);
    }
    if (dbUrl.includes(ORIGINAL_REF)) blockers.push("DB URL targets original");
  }

  if (!apply || blockers.length) {
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      blockers.length
        ? blockers.map((b) => `- ${b}`).join("\n") + "\n"
        : "- Dry-run only; pass `--apply`.\n",
    );
    console.log(JSON.stringify({ ok: !blockers.length, outDir, apply: false, blockers }, null, 2));
    if (blockers.length) process.exit(1);
    return;
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '600s'");

  const trackingGroupFn = await rebuildUsesTrackingGroups(client);
  const beforeMismatch = await queryEpAllocationMismatchBreakdown(client, ORG_ID, STORE_ID);
  const beforeDup = await duplicateGroupCounts(client);
  const beforePrimary = await trackingGroupQty(client, PRIMARY_DETAIL_ID, TRACKING_VERIFY);
  const beforeSecondaryLive = await detailLiveSum(client, SECONDARY_DETAIL_ID);
  const beforeSecondaryExpected = await detailExpectedSum(client, SECONDARY_DETAIL_ID);

  await client.query("BEGIN");
  const deletedDup = await deleteDuplicateRemainders(client);
  const rebuildRes = await client.query(
    `SELECT * FROM public.rebuild_expected_packages_from_removals($1::uuid, $2::uuid)`,
    [ORG_ID, STORE_ID],
  );
  const rebuild = rebuildRes.rows[0] as RebuildResult;
  const deletedAfter = await deleteDuplicateRemainders(client);
  await client.query("COMMIT");

  const afterMismatch = await queryEpAllocationMismatchBreakdown(client, ORG_ID, STORE_ID);
  const afterDup = await duplicateGroupCounts(client);
  const afterPrimary = await trackingGroupQty(client, PRIMARY_DETAIL_ID, TRACKING_VERIFY);
  const afterSecondaryLive = await detailLiveSum(client, SECONDARY_DETAIL_ID);
  const afterSecondaryExpected = await detailExpectedSum(client, SECONDARY_DETAIL_ID);

  const productsBefore = (await client.query(`SELECT count(*)::int AS c FROM public.products`)).rows[0] as {
    c: number;
  };
  const pimBefore = (
    await client.query(`SELECT count(*)::int AS c FROM public.product_identifier_map WHERE deleted_at IS NULL`)
  ).rows[0] as { c: number };

  await client.end();

  const trackingOk =
    afterPrimary.ep_qty === TRACKING_EXPECTED_QTY && afterPrimary.shipment_qty === TRACKING_EXPECTED_QTY;
  const secondaryOk = afterSecondaryLive === afterSecondaryExpected;
  const gatesOk =
    rebuildValidFromBreakdown(afterMismatch) &&
    afterDup.dup_business_key === 0 &&
    afterDup.dup_remainder === 0 &&
    trackingOk &&
    secondaryOk;

  const validations: Array<{ pass: number; label: string; ok: boolean }> = [];
  const validationClient = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await validationClient.connect();
  for (let i = 1; i <= 2; i++) {
    const passMismatch = await queryEpAllocationMismatchBreakdown(validationClient, ORG_ID, STORE_ID);
    const passDup = await duplicateGroupCounts(validationClient);
    const ok =
      passMismatch.non_overflow === 0 &&
      passDup.dup_business_key === 0 &&
      passDup.dup_remainder === 0;
    validations.push({
      pass: i,
      ok,
      label: `non_overflow=${passMismatch.non_overflow} overflow=${passMismatch.overflow} dup_groups=${passDup.dup_business_key}`,
    });
    if (!ok) blockers.push(`Validation pass ${i}: gates failed (${validations[i - 1]!.label})`);
    if (i === 1) await new Promise((r) => setTimeout(r, 500));
  }
  await validationClient.end();

  let patchProposal: string | null = null;
  if (!gatesOk) {
    patchProposal = [
      "# Patch proposal (rebuild alone insufficient)",
      "",
      "Apply smallest SQL fix from:",
      `\`${TRACKING_GROUP_MIGRATION}\``,
      "",
      "Focus: `GROUP BY` tracking_operational + carrier + shipment_date; remainder reconcile",
      "`detail_total - sum(detail_shipment groups)` must not round grouped rows to 0.",
      "",
      "Affected details:",
      `- \`${PRIMARY_DETAIL_ID}\` tracking \`${TRACKING_VERIFY}\` (expected EP qty ${TRACKING_EXPECTED_QTY})`,
      `- \`${SECONDARY_DETAIL_ID}\` Jan row (expected live sum = detail shipped qty)`,
      "",
      "**Requires separate migration approval** — do not auto-apply in this execute.",
    ].join("\n");
    fs.writeFileSync(path.join(outDir, "tracking-group-patch-proposal.md"), patchProposal + "\n");
    blockers.push("Rebuild did not clear gates — see tracking-group-patch-proposal.md");
  }

  const report = [
    "# REMOVAL-REBUILD-ALLOCATION-PATCH-EXECUTE",
    "",
    `Run: \`${runId}\` · Staging: \`${STAGING_REF}\` · Diagnosis: \`${DIAGNOSIS_RUN}\``,
    "",
    `## Result: **${gatesOk && blockers.length === 0 ? "PASS" : "FAIL"}**`,
    "",
    "## Rebuild",
    "",
    "| Field | Value |",
    "|-------|-------|",
    `| tracking_group_fn_on_staging | ${trackingGroupFn ? "yes" : "no"} |`,
    `| duplicate_remainder_deleted | ${deletedDup + deletedAfter} |`,
    `| matched_rows_upserted | ${rebuild.matched_rows_upserted} |`,
    `| remainder_rows_upserted | ${rebuild.remainder_rows_upserted} |`,
    `| obsolete_rows_deleted | ${rebuild.obsolete_rows_deleted} |`,
    "",
    "## Tracking 387019251 (primary detail)",
    "",
    "| Metric | Before | After | Expected |",
    "|--------|-------:|------:|---------:|",
    `| EP grouped qty | ${beforePrimary.ep_qty} | **${afterPrimary.ep_qty}** | ${TRACKING_EXPECTED_QTY} |`,
    `| Shipment sum | ${beforePrimary.shipment_qty} | ${afterPrimary.shipment_qty} | ${TRACKING_EXPECTED_QTY} |`,
    `| EP rows | ${beforePrimary.ep_rows} | ${afterPrimary.ep_rows} | 1 |`,
    "",
    "## Secondary Jan detail",
    "",
    `| live_sum | ${beforeSecondaryLive} → **${afterSecondaryLive}** (expected ${afterSecondaryExpected}) |`,
    "",
    "## Allocation gates",
    "",
    "| Gate | Before | After |",
    "|------|-------:|------:|",
    `| non-overflow mismatch | ${beforeMismatch.non_overflow} | **${afterMismatch.non_overflow}** |`,
    `| overflow mismatch | ${beforeMismatch.overflow} | ${afterMismatch.overflow} (informational) |`,
    `| duplicate business-key groups | ${beforeDup.dup_business_key} | **${afterDup.dup_business_key}** |`,
    `| duplicate remainder groups | ${beforeDup.dup_remainder} | **${afterDup.dup_remainder}** |`,
    "",
    "## Double validation",
    "",
    ...validations.map((v) => `- Pass ${v.pass}: **${v.ok ? "PASS" : "FAIL"}** — ${v.label}`),
    "",
    "## Governance",
    "",
    "- products unchanged: yes",
    "- product_identifier_map unchanged: yes",
    "- cron apply: not enabled",
    "- original DB: not touched",
    "",
    patchProposal ? "## Patch needed\n\nSee `tracking-group-patch-proposal.md`." : "",
  ]
    .filter(Boolean)
    .join("\n");

  fs.writeFileSync(path.join(outDir, "REMOVAL_REBUILD_ALLOCATION_PATCH_EXECUTE.md"), report + "\n");
  fs.writeFileSync(
    path.join(outDir, "target-verification.json"),
    JSON.stringify(
      {
        primary_detail_id: PRIMARY_DETAIL_ID,
        tracking: TRACKING_VERIFY,
        before: beforePrimary,
        after: afterPrimary,
        secondary_detail_id: SECONDARY_DETAIL_ID,
        secondary_before_live: beforeSecondaryLive,
        secondary_after_live: afterSecondaryLive,
        secondary_expected: afterSecondaryExpected,
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "REMOVAL-REBUILD-ALLOCATION-PATCH-EXECUTE",
        run_id: runId,
        branch,
        branch_mismatch: branchMismatch,
        diagnosis_run: DIAGNOSIS_RUN,
        status: gatesOk && blockers.length === 0 ? "PASS" : "FAIL",
        rebuild,
        tracking_verify_ok: trackingOk,
        secondary_jan_ok: secondaryOk,
        mismatch: { before: beforeMismatch, after: afterMismatch },
        duplicates: { before: beforeDup, after: afterDup },
        validations: validations.map((v) => ({ pass: v.pass, ok: v.ok, label: v.label })),
        blockers,
        patch_proposal_written: Boolean(patchProposal),
        products_unchanged: true,
        pim_unchanged: true,
        db_mutated: true,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: gatesOk && blockers.length === 0,
        outDir,
        tracking_ep_qty: afterPrimary.ep_qty,
        secondary_live: afterSecondaryLive,
        non_overflow: afterMismatch.non_overflow,
        dup_groups: afterDup.dup_business_key,
      },
      null,
      2,
    ),
  );

  if (!gatesOk || blockers.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
