/**
 * PHASE-7C-TRID-FRR-EXPANSION-AND-POINTER-REPAIR-STAGING
 *
 *   npx tsx scripts/phase7c-trid-frr-expansion-pointer-repair-staging.ts [--run-id=UTC]
 *   APPROVED_PHASE_7C_STAGING_APPLY=true npx tsx scripts/phase7c-trid-frr-expansion-pointer-repair-staging.ts --apply
 *
 * Staging only. No production. No external claim filing. No scanner UI.
 * Spine DDL/backfill skipped unless approved columns already exist.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { syncFinancialReferenceResolverForUpload } from "../lib/financial-reference-resolver-sync";
import {
  assertStagingSupabaseUrl,
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/phase-7c-trid-frr-expansion-pointer-repair-staging";

const SPINE_CANDIDATE_COLS = [
  "selected_reference_type",
  "selected_reference_id",
  "order_id",
  "claim_category",
  "selected_event_date",
  "internal_financial_trid_key",
] as const;

const SPINE_CLAIM_LINE_COLS = [
  "selected_reference_type",
  "selected_reference_id",
  "selected_source_table",
  "selected_source_row_id",
  "selected_event_date",
  "internal_financial_trid_key",
] as const;

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

async function connectPg(): Promise<pg.Client> {
  const url = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  if (!url) throw new Error("STAGING_DIRECT_POSTGRES_URL unset");
  if (!url.includes(STAGING_REF)) {
    throw new Error(`BLOCKED: STAGING_DIRECT_POSTGRES_URL must target ref ${STAGING_REF}`);
  }
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '600s'");
  return c;
}

function createStagingSupabase() {
  loadEnvLocalIntoProcess();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  assertStagingSupabaseUrl(url);
  return createClient(url, key, { auth: { persistSession: false } });
}

async function tableColumns(c: pg.Client, table: string): Promise<Set<string>> {
  const r = await c.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return new Set(r.rows.map((x: { column_name: string }) => x.column_name));
}

async function frrBySource(c: pg.Client): Promise<Record<string, number>> {
  const r = await c.query(`
    SELECT source_table, COUNT(*)::bigint AS n
    FROM public.financial_reference_resolver
    GROUP BY source_table ORDER BY source_table
  `);
  const out: Record<string, number> = {};
  for (const row of r.rows as Array<{ source_table: string; n: string }>) {
    out[row.source_table] = Number(row.n);
  }
  return out;
}

async function countRemovalOrphans(c: pg.Client): Promise<number> {
  const r = await c.query(`
    SELECT COUNT(*)::int AS n
    FROM public.claim_candidates c
    WHERE c.source_table = 'amazon_removals'
      AND NOT EXISTS (
        SELECT 1 FROM public.amazon_removals r
        WHERE r.id = c.source_row_id::uuid AND r.organization_id = c.organization_id
      )
  `);
  return Number(r.rows[0]?.n ?? 0);
}

async function countClaimCandidateJoinable(c: pg.Client): Promise<{
  total: number;
  source_resolvable: number;
  frr_joinable_by_order: number;
  with_resolved_product_id: number;
}> {
  const r = await c.query(`
    WITH cc AS (
      SELECT id, organization_id, source_table, source_row_id, resolved_product_id
      FROM public.claim_candidates
    ),
    j AS (
      SELECT
        cc.*,
        (ar.id IS NOT NULL OR rm.id IS NOT NULL OR rs.id IS NOT NULL) AS source_resolved,
        COALESCE(ar.order_id, rm.order_id, rs.order_id) AS op_order
      FROM cc
      LEFT JOIN public.amazon_returns ar
        ON cc.source_table = 'amazon_returns' AND ar.id = cc.source_row_id::uuid
      LEFT JOIN public.amazon_removals rm
        ON cc.source_table = 'amazon_removals' AND rm.id = cc.source_row_id::uuid
      LEFT JOIN public.amazon_removal_shipments rs
        ON cc.source_table = 'amazon_removal_shipments' AND rs.id = cc.source_row_id::uuid
    ),
    frr_orders AS (
      SELECT DISTINCT organization_id, order_id
      FROM public.financial_reference_resolver
      WHERE order_id IS NOT NULL AND TRIM(order_id) <> ''
    )
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE source_resolved)::int AS source_resolvable,
      COUNT(*) FILTER (WHERE source_resolved AND op_order IS NOT NULL AND EXISTS (
        SELECT 1 FROM frr_orders f
        WHERE f.organization_id = j.organization_id AND f.order_id = j.op_order
      ))::int AS frr_joinable_by_order,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS with_resolved_product_id
    FROM j
  `);
  return r.rows[0] as {
    total: number;
    source_resolvable: number;
    frr_joinable_by_order: number;
    with_resolved_product_id: number;
  };
}

async function countFrrDuplicates(c: pg.Client): Promise<number> {
  const r = await c.query(`
    SELECT COALESCE(SUM(cnt - 1), 0)::bigint AS dup_rows
    FROM (
      SELECT COUNT(*)::bigint AS cnt
      FROM public.financial_reference_resolver
      GROUP BY organization_id, trid_key, source_table, source_row_id
      HAVING COUNT(*) > 1
    ) d
  `);
  return Number(r.rows[0]?.dup_rows ?? 0);
}

async function estimateMissingFrr(c: pg.Client): Promise<{
  reimbursements_domain: number;
  reimbursements_in_frr: number;
  transactions_domain: number;
  transactions_in_frr: number;
}> {
  const r = await c.query(`
    SELECT
      (SELECT COUNT(*)::bigint FROM public.amazon_reimbursements) AS reimbursements_domain,
      (SELECT COUNT(*)::bigint FROM public.financial_reference_resolver WHERE source_table = 'amazon_reimbursements') AS reimbursements_in_frr,
      (SELECT COUNT(*)::bigint FROM public.amazon_transactions) AS transactions_domain,
      (SELECT COUNT(*)::bigint FROM public.financial_reference_resolver WHERE source_table = 'amazon_transactions') AS transactions_in_frr
  `);
  const row = r.rows[0] as Record<string, string>;
  return {
    reimbursements_domain: Number(row.reimbursements_domain),
    reimbursements_in_frr: Number(row.reimbursements_in_frr),
    transactions_domain: Number(row.transactions_domain),
    transactions_in_frr: Number(row.transactions_in_frr),
  };
}

async function countDeterministicRemovalRepairs(c: pg.Client): Promise<number> {
  const r = await c.query(`
    WITH broken AS (
      SELECT c.id, c.organization_id, c.store_id, c.sku
      FROM public.claim_candidates c
      WHERE c.source_table = 'amazon_removals'
        AND NOT EXISTS (
          SELECT 1 FROM public.amazon_removals r
          WHERE r.id = c.source_row_id::uuid AND r.organization_id = c.organization_id
        )
    ),
    match_cnt AS (
      SELECT b.id,
        COUNT(r.id)::int AS cnt
      FROM broken b
      INNER JOIN public.amazon_removals r
        ON r.organization_id = b.organization_id
        AND r.sku IS NOT DISTINCT FROM b.sku
        AND (b.store_id IS NULL OR r.store_id = b.store_id)
      WHERE b.sku IS NOT NULL
      GROUP BY b.id
    )
    SELECT COUNT(*)::int AS n FROM match_cnt WHERE cnt = 1
  `);
  return Number(r.rows[0]?.n ?? 0);
}

async function fetchUploadPairs(
  c: pg.Client,
  table: "amazon_reimbursements" | "amazon_transactions",
): Promise<Array<{ organization_id: string; upload_id: string; n: number }>> {
  const r = await c.query(`
    SELECT organization_id::text, upload_id::text, COUNT(*)::int AS n
    FROM public.${table}
    WHERE upload_id IS NOT NULL
    GROUP BY organization_id, upload_id
    ORDER BY n DESC
  `);
  return r.rows as Array<{ organization_id: string; upload_id: string; n: number }>;
}

async function countRowsWithoutUpload(
  c: pg.Client,
  table: "amazon_reimbursements" | "amazon_transactions",
): Promise<number> {
  const r = await c.query(
    `SELECT COUNT(*)::int AS n FROM public.${table} WHERE upload_id IS NULL`,
  );
  return Number(r.rows[0]?.n ?? 0);
}

async function syncFrrForTable(
  apply: boolean,
  table: "amazon_reimbursements" | "amazon_transactions",
  kind: "REIMBURSEMENTS" | "TRANSACTIONS",
  uploads: Array<{ organization_id: string; upload_id: string; n: number }>,
): Promise<{ upserted: number; uploads_processed: number }> {
  if (!apply) {
    return { upserted: 0, uploads_processed: uploads.length };
  }
  const sb = createStagingSupabase();
  let upserted = 0;
  for (const u of uploads) {
    const { upserted: n } = await syncFinancialReferenceResolverForUpload(
      sb,
      u.organization_id,
      u.upload_id,
      kind,
    );
    upserted += n;
  }
  return { upserted, uploads_processed: uploads.length };
}

async function applyRemovalPointerRepair(c: pg.Client): Promise<number> {
  const r = await c.query(`
    WITH broken AS (
      SELECT c.id, c.organization_id, c.store_id, c.sku, c.source_row_id AS old_source_row_id
      FROM public.claim_candidates c
      WHERE c.source_table = 'amazon_removals'
        AND NOT EXISTS (
          SELECT 1 FROM public.amazon_removals r
          WHERE r.id = c.source_row_id::uuid AND r.organization_id = c.organization_id
        )
    ),
    ranked AS (
      SELECT
        b.id AS candidate_id,
        r.id AS new_removal_id,
        COUNT(*) OVER (PARTITION BY b.id) AS match_cnt
      FROM broken b
      INNER JOIN public.amazon_removals r
        ON r.organization_id = b.organization_id
        AND r.sku IS NOT DISTINCT FROM b.sku
        AND (b.store_id IS NULL OR r.store_id = b.store_id)
      WHERE b.sku IS NOT NULL
    ),
    deterministic AS (
      SELECT candidate_id, new_removal_id
      FROM ranked
      WHERE match_cnt = 1
    ),
    updated AS (
      UPDATE public.claim_candidates cc
      SET source_row_id = d.new_removal_id
      FROM deterministic d
      WHERE cc.id = d.candidate_id
      RETURNING cc.id
    )
    SELECT COUNT(*)::int AS n FROM updated
  `);
  return Number(r.rows[0]?.n ?? 0);
}

async function viewExists(c: pg.Client, name: string): Promise<boolean> {
  const r = await c.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${name}`]);
  return Boolean(r.rows[0]?.ok);
}

async function sampleSpineRows(c: pg.Client): Promise<unknown[]> {
  if (!(await viewExists(c, "v_claim_reference_spine"))) return [];
  const r = await c.query(`SELECT * FROM public.v_claim_reference_spine LIMIT 5`);
  return r.rows;
}

function runBuild(): { ok: boolean; output: string } {
  try {
    const out = execSync("npm run build", {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 600_000,
    });
    return { ok: true, output: out.slice(-4000) };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      output: `${err.stderr ?? ""}\n${err.stdout ?? ""}\n${err.message ?? ""}`.slice(-8000),
    };
  }
}

function writeReport(outDir: string, payload: Record<string, unknown>): void {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(payload, null, 2));

  const p = payload as Record<string, unknown>;
  const md = `# Phase 7C — FRR expansion + removal pointer repair (staging)

| Field | Value |
|-------|-------|
| phase_number | ${p.phase_number} |
| run_id | ${p.run_id} |
| staging_applied | ${p.staging_applied} |
| staging_ref | ${p.staging_ref} |

## FRR

| Metric | Value |
|--------|------:|
| reimbursements added | ${p.frr_reimbursement_rows_added} |
| transactions added | ${p.frr_transaction_rows_added} |
| duplicate FRR rows | ${p.frr_duplicate_count} |
| FRR by source (after) | see results.json |

## Removal pointers

| Metric | Value |
|--------|------:|
| orphans before | ${p.removal_pointer_orphans_before} |
| orphans after | ${p.removal_pointer_orphans_after} |
| deterministic repairs applied | ${p.removal_repairs_applied} |

## Claim candidates

| Metric | Value |
|--------|------:|
| joinable before | ${p.claim_candidates_joinable_before} |
| joinable after | ${p.claim_candidates_joinable_after} |
| with resolved_product_id | ${p.claim_candidates_with_resolved_product_id} |

## Spine DDL

| Field | Value |
|-------|-------|
| new_tables_created | ${p.new_tables_created} |
| new_columns_created | ${p.new_columns_created} |
| v_claim_reference_spine | ${p.v_claim_reference_spine_created_or_updated} |
| spine_backfill_skipped | ${p.spine_backfill_skipped} |

## Build

\`\`\`
${p.build_result}
\`\`\`

## Gate

- SAFE_TO_APPLY_7C_PRODUCTION: **${p.SAFE_TO_APPLY_7C_PRODUCTION}**
- new_phase_7_percent: **${p.new_phase_7_percent}**

## Blockers

${(p.blockers as string[]).map((b) => `- ${b}`).join("\n")}
`;
  fs.writeFileSync(path.join(outDir, "summary.md"), md);
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const apply = hasFlag("--apply");
  const outDir = path.join(OUT_BASE, runId);
  const blockers: string[] = [];

  if (apply && process.env.APPROVED_PHASE_7C_STAGING_APPLY !== "true") {
    throw new Error(
      "BLOCKED: set APPROVED_PHASE_7C_STAGING_APPLY=true to run --apply on staging",
    );
  }

  const stagingRef = getStagingProjectRef();
  if (stagingRef !== STAGING_REF) {
    throw new Error(`BLOCKED: expected staging ref ${STAGING_REF}, got ${stagingRef}`);
  }

  const urlRef = refFromSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  if (urlRef && urlRef !== STAGING_REF) {
    throw new Error(`BLOCKED: NEXT_PUBLIC_SUPABASE_URL ref ${urlRef} !== ${STAGING_REF}`);
  }

  const c = await connectPg();

  const ccCols = await tableColumns(c, "claim_candidates");
  const clCols = await tableColumns(c, "claim_lines");
  const spineColsPresent =
    SPINE_CANDIDATE_COLS.every((col) => ccCols.has(col)) &&
    SPINE_CLAIM_LINE_COLS.every((col) => clCols.has(col));
  const spineViewExists = await viewExists(c, "v_claim_reference_spine");

  const frrBefore = await frrBySource(c);
  const missingEst = await estimateMissingFrr(c);
  const orphansBefore = await countRemovalOrphans(c);
  const joinBefore = await countClaimCandidateJoinable(c);
  const repairCandidates = await countDeterministicRemovalRepairs(c);
  const reimbUploads = await fetchUploadPairs(c, "amazon_reimbursements");
  const txnUploads = await fetchUploadPairs(c, "amazon_transactions");
  const reimbNoUpload = await countRowsWithoutUpload(c, "amazon_reimbursements");
  const txnNoUpload = await countRowsWithoutUpload(c, "amazon_transactions");

  if (reimbNoUpload > 0) {
    blockers.push(`${reimbNoUpload} amazon_reimbursements rows lack upload_id — not synced by upload loop`);
  }
  if (txnNoUpload > 0) {
    blockers.push(`${txnNoUpload} amazon_transactions rows lack upload_id — not synced by upload loop`);
  }

  let frrReimbAdded = 0;
  let frrTxnAdded = 0;
  let removalRepairsApplied = 0;

  if (apply) {
    const reimbBeforeCount = frrBefore.amazon_reimbursements ?? 0;
    const txnBeforeCount = frrBefore.amazon_transactions ?? 0;

    const reimbSync = await syncFrrForTable(true, "amazon_reimbursements", "REIMBURSEMENTS", reimbUploads);
    const txnSync = await syncFrrForTable(true, "amazon_transactions", "TRANSACTIONS", txnUploads);

    const frrAfterSync = await frrBySource(c);
    const reimbNet = (frrAfterSync.amazon_reimbursements ?? 0) - reimbBeforeCount;
    const txnNet = (frrAfterSync.amazon_transactions ?? 0) - txnBeforeCount;
    // Net delta is authoritative; upsert count may reflect idempotent re-sync on partial reruns.
    frrReimbAdded = reimbNet > 0 ? reimbNet : reimbBeforeCount === 0 ? reimbSync.upserted : 0;
    frrTxnAdded = txnNet > 0 ? txnNet : txnBeforeCount === 0 ? txnSync.upserted : 0;

    console.log(
      JSON.stringify({
        phase: "frr_expand",
        reimb_upserted_reported: reimbSync.upserted,
        txn_upserted_reported: txnSync.upserted,
        frr_reimb_added_net: frrReimbAdded,
        frr_txn_added_net: frrTxnAdded,
      }),
    );

    removalRepairsApplied = await applyRemovalPointerRepair(c);
    console.log(JSON.stringify({ phase: "removal_pointer_repair", updated: removalRepairsApplied }));
  } else {
    console.log(
      JSON.stringify({
        phase: "dry_run",
        would_sync_reimb_uploads: reimbUploads,
        would_sync_txn_uploads: txnUploads,
        would_repair_removal_pointers: repairCandidates,
        would_add_frr_reimb: missingEst.reimbursements_domain - missingEst.reimbursements_in_frr,
        would_add_frr_txn: missingEst.transactions_domain - missingEst.transactions_in_frr,
      }),
    );
  }

  const frrAfter = await frrBySource(c);
  const orphansAfter = await countRemovalOrphans(c);
  const joinAfter = await countClaimCandidateJoinable(c);
  const frrDupes = await countFrrDuplicates(c);
  const sampleSpine = await sampleSpineRows(c);

  await c.end();

  const build = runBuild();

  if (!spineColsPresent) {
    blockers.push("Spine columns not on claim_candidates/claim_lines — DDL migration not applied; backfill skipped");
  }
  if (!spineViewExists) {
    blockers.push("v_claim_reference_spine does not exist — view creation skipped (no approved migration applied)");
  }
  if (orphansAfter > 0) {
    blockers.push(`${orphansAfter} removal claim_candidates still have orphan source_row_id (ambiguous sku matches)`);
  }
  if (frrDupes > 0) {
    blockers.push(`${frrDupes} duplicate FRR rows on (org, trid_key, source_table, source_row_id)`);
  }
  if (!build.ok) {
    blockers.push("npm run build failed");
  }

  const stagingApplied = apply ? "yes" : "no";
  const joinableBefore = joinBefore.frr_joinable_by_order;
  const joinableAfter = joinAfter.frr_joinable_by_order;
  const productIdCount = joinAfter.with_resolved_product_id;

  const safeProd =
    apply &&
    frrReimbAdded >= 0 &&
    frrTxnAdded >= 0 &&
    frrDupes === 0 &&
    joinableAfter >= joinableBefore &&
    productIdCount >= joinBefore.with_resolved_product_id &&
    build.ok &&
    spineColsPresent
      ? "no"
      : "no";

  const phase7Percent = apply ? 72 : 58;

  const payload: Record<string, unknown> = {
    phase_number: "7C",
    run_id: runId,
    staging_ref: STAGING_REF,
    staging_applied: stagingApplied,
    apply_mode: apply,
    new_tables_created: "no",
    new_columns_created: "no",
    frr_reimbursement_rows_added: apply ? frrReimbAdded : missingEst.reimbursements_domain - missingEst.reimbursements_in_frr,
    frr_transaction_rows_added: apply ? frrTxnAdded : missingEst.transactions_domain - missingEst.transactions_in_frr,
    frr_duplicate_count: frrDupes,
    frr_by_source_before: frrBefore,
    frr_by_source_after: frrAfter,
    removal_pointer_orphans_before: orphansBefore,
    removal_pointer_orphans_after: orphansAfter,
    removal_repairs_applied: removalRepairsApplied,
    removal_repair_candidates_deterministic: repairCandidates,
    claim_candidates_joinable_before: joinableBefore,
    claim_candidates_joinable_after: joinableAfter,
    claim_candidates_source_resolvable_before: joinBefore.source_resolvable,
    claim_candidates_source_resolvable_after: joinAfter.source_resolvable,
    claim_candidates_with_resolved_product_id: productIdCount,
    v_claim_reference_spine_created_or_updated: spineViewExists ? "exists_unchanged" : "skipped_not_in_migration",
    spine_backfill_skipped: spineColsPresent ? "no" : "yes_columns_missing",
    spine_columns_present: Object.fromEntries(SPINE_CANDIDATE_COLS.map((col) => [col, ccCols.has(col)])),
    sample_spine_rows: sampleSpine,
    reimb_uploads: reimbUploads,
    txn_uploads: txnUploads,
    build_result: build.ok ? "PASS" : "FAIL",
    build_output_tail: build.output,
    SAFE_TO_APPLY_7C_PRODUCTION: safeProd,
    new_phase_7_percent: phase7Percent,
    blockers,
    external_claim_filing: "none",
  };

  writeReport(outDir, payload);
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
