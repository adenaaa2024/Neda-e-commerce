/**
 * EXPECTED-LINKAGE-RETURN-ITEMS-BACKFILL-SCALE-WAVE2
 *   npx tsx scripts/expected-linkage-return-items-backfill-scale-wave2-execute.ts --run-id=<UTC>
 *   npx tsx scripts/expected-linkage-return-items-backfill-scale-wave2-execute.ts --run-id=<UTC> --apply
 *   npx tsx scripts/expected-linkage-return-items-backfill-scale-wave2-execute.ts --run-id=<UTC> --apply --batch-size=500
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
const APPROVAL_PATH =
  ".cursor/operator-approvals/expected-linkage-return-items-backfill-scale-wave2-approval.md";
const OUT_BASE = ".cursor/audit-reports/expected-linkage-return-items-backfill-scale-wave2";
const DEFAULT_BATCH_SIZE = 500;

type OrphanRow = {
  return_item_id: string;
  expected_item_id: string;
  ep_resolved_product_id: string;
  legacy_product_id: string | null;
  identifier_resolution_status: string | null;
  identifier_resolution_confidence: string | null;
  current_resolved_product_id: string | null;
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

function batchSizeArg(approvalMax: number): number {
  const a = process.argv.find((x) => x.startsWith("--batch-size="));
  const n = a ? Number(a.split("=")[1]) : DEFAULT_BATCH_SIZE;
  if (!Number.isFinite(n) || n < 1) throw new Error("Invalid --batch-size");
  if (n > approvalMax) throw new Error(`batch-size ${n} exceeds approval max ${approvalMax}`);
  return Math.floor(n);
}

function sqlLit(v: string | null | undefined): string {
  if (v == null || v === "") return "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

function readApproval(): { ok: boolean; maxBatch: number } {
  const p = path.join(process.cwd(), APPROVAL_PATH);
  if (!fs.existsSync(p)) return { ok: false, maxBatch: 0 };
  const text = fs.readFileSync(p, "utf8");
  const maxMatch = text.match(/APPROVED_RETURN_ITEMS_SCALE_MAX_BATCH\s*=\s*(\d+)/i);
  const maxBatch = maxMatch ? Number(maxMatch[1]) : 0;
  const ok =
    /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text) &&
    /APPROVED_RETURN_ITEMS_EP_COPY_SCALE\s*=\s*true/i.test(text) &&
    maxBatch > 0 &&
    /APPROVED_PRODUCT_CREATE\s*=\s*false/i.test(text) &&
    /APPROVED_MAP_INSERT\s*=\s*false/i.test(text) &&
    /APPROVED_CLASS_C_SEED\s*=\s*false/i.test(text) &&
    new RegExp(`TARGET_SUPABASE_REF\\s*=\\s*${STAGING_REF}`, "i").test(text);
  return { ok, maxBatch };
}

async function linkageCounts(client: pg.Client): Promise<Record<string, number>> {
  const r = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM public.products) AS products,
      (SELECT COUNT(*)::int FROM public.product_identifier_map) AS product_identifier_map,
      (SELECT COUNT(*)::int FROM public.expected_packages) AS expected_packages,
      (SELECT COUNT(*)::int FROM public.expected_packages WHERE resolved_product_id IS NOT NULL) AS ep_resolved,
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL) AS return_items_active,
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL AND resolved_product_id IS NOT NULL) AS return_items_resolved,
      (SELECT COUNT(*)::int
         FROM public.return_items ri
         JOIN public.expected_packages ep ON ep.id = ri.expected_item_id
        WHERE ri.deleted_at IS NULL
          AND ri.resolved_product_id IS NULL
          AND ep.resolved_product_id IS NOT NULL
          AND (ri.product_id IS NULL OR ri.product_id = ep.resolved_product_id)) AS orphan_eligible,
      (SELECT COUNT(*)::int
         FROM public.return_items ri
         JOIN public.expected_packages ep ON ep.id = ri.expected_item_id
        WHERE ri.deleted_at IS NULL
          AND ri.resolved_product_id IS NULL
          AND ep.resolved_product_id IS NOT NULL
          AND ri.product_id IS NOT NULL
          AND ri.product_id IS DISTINCT FROM ep.resolved_product_id) AS orphan_legacy_conflict
  `);
  return r.rows[0] as Record<string, number>;
}

async function fetchOrphanBatch(client: pg.Client, limit: number): Promise<OrphanRow[]> {
  const r = await client.query(
    `
    SELECT
      ri.id::text AS return_item_id,
      ri.expected_item_id::text AS expected_item_id,
      ep.resolved_product_id::text AS ep_resolved_product_id,
      ri.product_id::text AS legacy_product_id,
      ri.identifier_resolution_status,
      ri.identifier_resolution_confidence::text,
      ri.resolved_product_id::text AS current_resolved_product_id
    FROM public.return_items ri
    JOIN public.expected_packages ep ON ep.id = ri.expected_item_id
    WHERE ri.deleted_at IS NULL
      AND ri.resolved_product_id IS NULL
      AND ep.resolved_product_id IS NOT NULL
      AND (ri.product_id IS NULL OR ri.product_id = ep.resolved_product_id)
    ORDER BY ri.id
    LIMIT $1
    `,
    [limit],
  );
  return r.rows as OrphanRow[];
}

async function verifyBatchPre(client: pg.Client, rows: OrphanRow[]): Promise<string[]> {
  if (rows.length === 0) return [];
  const r = await client.query(
    `
    WITH batch AS (
      SELECT *
      FROM jsonb_to_recordset($1::jsonb) AS x(
        return_item_id uuid,
        expected_item_id uuid,
        ep_resolved_product_id uuid
      )
    )
    SELECT
      b.return_item_id::text,
      ri.resolved_product_id::text AS current_resolved_product_id,
      ri.product_id::text AS legacy_product_id,
      ep.resolved_product_id::text AS ep_resolved_product_id
    FROM batch b
    JOIN public.return_items ri ON ri.id = b.return_item_id
    JOIN public.expected_packages ep ON ep.id = b.expected_item_id
    WHERE ri.deleted_at IS NULL
    `,
    [
      JSON.stringify(
        rows.map((row) => ({
          return_item_id: row.return_item_id,
          expected_item_id: row.expected_item_id,
          ep_resolved_product_id: row.ep_resolved_product_id,
        })),
      ),
    ],
  );

  const blockers: string[] = [];
  if (r.rows.length !== rows.length) {
    blockers.push(`Batch row count mismatch: expected ${rows.length}, found ${r.rows.length}`);
  }
  for (const row of r.rows) {
    if (row.current_resolved_product_id != null) {
      blockers.push(`Return item ${row.return_item_id}: already resolved`);
    }
    if (row.ep_resolved_product_id == null) {
      blockers.push(`Return item ${row.return_item_id}: linked EP unresolved`);
    }
    if (row.legacy_product_id != null && row.legacy_product_id !== row.ep_resolved_product_id) {
      blockers.push(`Return item ${row.return_item_id}: legacy product_id conflicts EP target`);
    }
  }
  return blockers;
}

async function applyBatch(client: pg.Client, rows: OrphanRow[]): Promise<Record<string, unknown>[]> {
  const r = await client.query(
    `
    WITH batch AS (
      SELECT *
      FROM jsonb_to_recordset($1::jsonb) AS x(return_item_id uuid)
    ),
    updated AS (
      UPDATE public.return_items ri
      SET resolved_product_id = ep.resolved_product_id,
          identifier_resolution_status = 'resolved',
          identifier_resolution_confidence = 1.0,
          updated_at = now()
      FROM public.expected_packages ep, batch b
      WHERE ri.id = b.return_item_id
        AND ri.expected_item_id = ep.id
        AND ri.deleted_at IS NULL
        AND ri.resolved_product_id IS NULL
        AND ep.resolved_product_id IS NOT NULL
        AND (ri.product_id IS NULL OR ri.product_id = ep.resolved_product_id)
      RETURNING ri.id::text AS return_item_id, ri.resolved_product_id::text, ep.id::text AS expected_item_id
    )
    SELECT * FROM updated
    `,
    [JSON.stringify(rows.map((row) => ({ return_item_id: row.return_item_id })))],
  );
  return r.rows;
}

function rollbackLinesForRows(rows: OrphanRow[]): string[] {
  return rows.map(
    (row) =>
      `UPDATE public.return_items SET resolved_product_id = ${row.current_resolved_product_id == null ? "NULL" : `${sqlLit(row.current_resolved_product_id)}::uuid`}, identifier_resolution_status = ${sqlLit(row.identifier_resolution_status)}, identifier_resolution_confidence = ${row.identifier_resolution_confidence ?? "NULL"}, updated_at = now() WHERE id = ${sqlLit(row.return_item_id)}::uuid;`,
  );
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const approval = readApproval();
  if (!approval.ok) {
    throw new Error(`Approval flags missing or false in ${APPROVAL_PATH}`);
  }
  const batchSize = batchSizeArg(approval.maxBatch);
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  if (
    !dbUrl ||
    getStagingProjectRef({ loadEnv: false }) !== STAGING_REF ||
    !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)
  ) {
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF})`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");

  const beforeCounts = await linkageCounts(client);
  fs.writeFileSync(path.join(outDir, "before-counts.json"), JSON.stringify(beforeCounts, null, 2));

  const batchResults: Record<string, unknown>[] = [];
  const allApplied: Record<string, unknown>[] = [];
  const rollbackLines = [
    "-- Rollback EXPECTED-LINKAGE-RETURN-ITEMS-BACKFILL-SCALE-WAVE2",
    `-- run_id: ${runId}`,
    "",
  ];
  let totalApplied = 0;
  let stoppedEarly = false;
  let stopReason = "";

  while (true) {
    const batchNum = batchResults.length + 1;
    const batchRows = await fetchOrphanBatch(client, batchSize);
    if (batchRows.length === 0) break;

    const blockers = await verifyBatchPre(client, batchRows);
    const batchDir = path.join(outDir, `batch-${String(batchNum).padStart(3, "0")}`);
    fs.mkdirSync(batchDir, { recursive: true });
    fs.writeFileSync(path.join(batchDir, "preimage.json"), JSON.stringify(batchRows, null, 2));

    if (blockers.length > 0) {
      fs.writeFileSync(path.join(batchDir, "blockers.md"), `# Blocked\n\n${blockers.map((b) => `- ${b}`).join("\n")}\n`);
      stoppedEarly = true;
      stopReason = blockers.join("; ");
      batchResults.push({
        batch: batchNum,
        mode: apply ? "apply" : "dry-run",
        rows_selected: batchRows.length,
        rows_applied: 0,
        status: "BLOCKED",
        blockers,
      });
      break;
    }

    let applied: Record<string, unknown>[] = [];
    if (apply) {
      await client.query("BEGIN");
      try {
        applied = await applyBatch(client, batchRows);
        if (applied.length !== batchRows.length) {
          throw new Error(`Apply mismatch: expected ${batchRows.length}, updated ${applied.length}`);
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        stoppedEarly = true;
        stopReason = e instanceof Error ? e.message : String(e);
        batchResults.push({
          batch: batchNum,
          mode: "apply",
          rows_selected: batchRows.length,
          rows_applied: 0,
          status: "FAIL",
          error: stopReason,
        });
        break;
      }
    }

    const midCounts = await linkageCounts(client);
    const expectedResolvedDelta = apply ? batchRows.length : 0;
    const actualResolvedDelta =
      Number(midCounts.return_items_resolved ?? 0) - Number(beforeCounts.return_items_resolved ?? 0);
    const productUnchanged = Number(midCounts.products) === Number(beforeCounts.products);
    const mapUnchanged = Number(midCounts.product_identifier_map) === Number(beforeCounts.product_identifier_map);
    const resolvedDeltaOk = !apply || actualResolvedDelta === totalApplied + batchRows.length;

    rollbackLines.push(...rollbackLinesForRows(batchRows));
    allApplied.push(...applied);
    totalApplied += apply ? applied.length : 0;

    const batchPass =
      blockers.length === 0 &&
      productUnchanged &&
      mapUnchanged &&
      resolvedDeltaOk &&
      (!apply || applied.length === batchRows.length);

    batchResults.push({
      batch: batchNum,
      mode: apply ? "apply" : "dry-run",
      rows_selected: batchRows.length,
      rows_applied: applied.length,
      status: batchPass ? "PASS" : "FAIL",
      counts_after: midCounts,
      verification: {
        product_count_unchanged: productUnchanged,
        map_count_unchanged: mapUnchanged,
        resolved_delta_expected: expectedResolvedDelta,
        resolved_delta_cumulative: actualResolvedDelta,
        resolved_delta_ok: resolvedDeltaOk,
      },
    });

    fs.writeFileSync(path.join(batchDir, "batch-result.json"), JSON.stringify(batchResults[batchResults.length - 1], null, 2));
    fs.writeFileSync(path.join(batchDir, "applied.json"), JSON.stringify(applied, null, 2));

    if (!batchPass) {
      stoppedEarly = true;
      stopReason = `Batch ${batchNum} verification failed`;
      break;
    }

    if (!apply) break;
  }

  const afterCounts = await linkageCounts(client);
  await client.end();

  fs.writeFileSync(path.join(outDir, "after-counts.json"), JSON.stringify(afterCounts, null, 2));
  fs.writeFileSync(path.join(outDir, "batch-results.json"), JSON.stringify(batchResults, null, 2));
  fs.writeFileSync(path.join(outDir, "all-applied.json"), JSON.stringify(allApplied, null, 2));
  fs.writeFileSync(path.join(outDir, "rollback.sql"), `${rollbackLines.join("\n")}\n`);

  let censusRunId: string | null = null;
  if (apply && !stoppedEarly && totalApplied > 0) {
    try {
      censusRunId = runId.replace(/Z$/, "CENSUSZ");
      execSync(`npx tsx scripts/expected-product-linkage-gap-census.ts --run-id=${censusRunId}`, {
        stdio: "pipe",
        encoding: "utf8",
        timeout: 300_000,
      });
    } catch (e) {
      censusRunId = `FAILED: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  const productCountUnchanged = beforeCounts.products === afterCounts.products;
  const mapCountUnchanged = beforeCounts.product_identifier_map === afterCounts.product_identifier_map;
  const resolvedIncrease = Number(afterCounts.return_items_resolved) - Number(beforeCounts.return_items_resolved);
  const resolvedDeltaOk = !apply || resolvedIncrease === totalApplied;
  const orphanDecrease =
    Number(beforeCounts.orphan_eligible) - Number(afterCounts.orphan_eligible);
  const orphanDecreaseOk = !apply || orphanDecrease === totalApplied;

  const overallPass =
    !stoppedEarly &&
    productCountUnchanged &&
    mapCountUnchanged &&
    resolvedDeltaOk &&
    orphanDecreaseOk &&
    (apply ? totalApplied > 0 || beforeCounts.orphan_eligible === 0 : true);

  fs.writeFileSync(
    path.join(outDir, "apply-result.md"),
    [
      "# Expected linkage return_items backfill scale wave2",
      "",
      `- Mode: **${apply ? "APPLY" : "DRY-RUN"}**`,
      `- Batch size: **${batchSize}** (approval max ${approval.maxBatch})`,
      `- Batches run: **${batchResults.length}**`,
      `- Rows applied: **${totalApplied}**`,
      `- Stopped early: **${stoppedEarly ? `YES — ${stopReason}` : "NO"}**`,
      "",
      "## Counts",
      "",
      "| Metric | Before | After | Delta |",
      "|--------|-------:|------:|------:|",
      `| products | ${beforeCounts.products} | ${afterCounts.products} | ${Number(afterCounts.products) - Number(beforeCounts.products)} |`,
      `| product_identifier_map | ${beforeCounts.product_identifier_map} | ${afterCounts.product_identifier_map} | ${Number(afterCounts.product_identifier_map) - Number(beforeCounts.product_identifier_map)} |`,
      `| return_items resolved | ${beforeCounts.return_items_resolved} | ${afterCounts.return_items_resolved} | ${resolvedIncrease} |`,
      `| orphan eligible pool | ${beforeCounts.orphan_eligible} | ${afterCounts.orphan_eligible} | ${Number(afterCounts.orphan_eligible) - Number(beforeCounts.orphan_eligible)} |`,
      `| orphan legacy conflict (excluded) | ${beforeCounts.orphan_legacy_conflict} | ${afterCounts.orphan_legacy_conflict} | ${Number(afterCounts.orphan_legacy_conflict) - Number(beforeCounts.orphan_legacy_conflict)} |`,
      "",
      "## Verification",
      "",
      `- Product count unchanged: ${productCountUnchanged ? "PASS" : "FAIL"}`,
      `- Map count unchanged: ${mapCountUnchanged ? "PASS" : "FAIL"}`,
      `- Resolved increase = applied (${resolvedIncrease} vs ${totalApplied}): ${resolvedDeltaOk ? "PASS" : "FAIL"}`,
      `- Orphan pool decrease = applied (${orphanDecrease} vs ${totalApplied}): ${orphanDecreaseOk ? "PASS" : "FAIL"}`,
      `- Legacy conflict pool unchanged: ${beforeCounts.orphan_legacy_conflict === afterCounts.orphan_legacy_conflict ? "PASS" : "FAIL"}`,
      `- Overall: **${overallPass ? "PASS" : apply ? "FAIL" : "PENDING (--apply)"}**`,
      "",
      "## Post census",
      "",
      censusRunId
        ? `- \`.cursor/audit-reports/expected-product-linkage-gap-census/${censusRunId}/\``
        : apply && totalApplied > 0
          ? "- Census re-run failed or skipped"
          : "- Census re-run after apply only",
      "",
      "## Rollback",
      "",
      "- `rollback.sql` in this folder",
    ].join("\n"),
  );

  const manifest = {
    prompt: "EXPECTED-LINKAGE-RETURN-ITEMS-BACKFILL-SCALE-WAVE2",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: apply ? "apply" : "dry-run",
    batch_size: batchSize,
    batches: batchResults.length,
    rows_applied: totalApplied,
    stopped_early: stoppedEarly,
    stop_reason: stopReason || null,
    status: overallPass ? "PASS" : apply ? "FAIL" : "DRY-RUN",
    before_counts: beforeCounts,
    after_counts: afterCounts,
    census_run_id: censusRunId,
    rollback_path: `${OUT_BASE}/${runId}/rollback.sql`,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));

  if (stoppedEarly && apply) process.exit(1);
  if (!overallPass && apply) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
