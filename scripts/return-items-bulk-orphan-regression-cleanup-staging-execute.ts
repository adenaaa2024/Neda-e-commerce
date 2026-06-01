/**
 * RETURN-ITEMS-BULK-ORPHAN-REGRESSION-CLEANUP-STAGING
 *
 *   npx tsx scripts/return-items-bulk-orphan-regression-cleanup-staging-execute.ts --run-id=<UTC>
 *   npx tsx scripts/return-items-bulk-orphan-regression-cleanup-staging-execute.ts --run-id=<UTC> --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";
import { sqlExcludeBulkOrphanReturnItems } from "../lib/return-item-physical-scan";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const APPROVAL_PATH =
  ".cursor/operator-approvals/return-items-bulk-orphan-regression-cleanup-staging-approval.md";
const LOCKDOWN_BASE = ".cursor/audit-reports/return-items-bulk-orphan-lockdown-staging";
const OUT_BASE = ".cursor/audit-reports/return-items-bulk-orphan-regression-cleanup-staging";

const TARGET_PREDICATE = `deleted_at IS NULL
AND expected_item_id IS NOT NULL
AND package_id IS NULL
AND pallet_id IS NULL`;

const TARGET_WHERE = `
  deleted_at IS NULL
  AND expected_item_id IS NOT NULL
  AND package_id IS NULL
  AND pallet_id IS NULL
`;

const TARGET_WHERE_RI = `
  ri.deleted_at IS NULL
  AND ri.expected_item_id IS NOT NULL
  AND ri.package_id IS NULL
  AND ri.pallet_id IS NULL
`;

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

function readApproval(): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const p = path.join(process.cwd(), APPROVAL_PATH);
  if (!fs.existsSync(p)) return { ok: false, reasons: ["approval_file_missing"] };
  const text = fs.readFileSync(p, "utf8");
  if (!/APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text)) {
    reasons.push("APPROVED_TO_RUN_STAGING_not_true");
  }
  if (!/APPROVED_RETURN_ITEMS_BULK_ORPHAN_REGRESSION_CLEANUP\s*=\s*true/i.test(text)) {
    reasons.push("APPROVED_RETURN_ITEMS_BULK_ORPHAN_REGRESSION_CLEANUP_not_true");
  }
  if (!new RegExp(`TARGET_SUPABASE_REF\\s*=\\s*${STAGING_REF}`, "i").test(text)) {
    reasons.push("TARGET_SUPABASE_REF_mismatch");
  }
  return { ok: reasons.length === 0, reasons };
}

function latestLockdownSafe(): boolean {
  const base = path.join(process.cwd(), LOCKDOWN_BASE);
  if (!fs.existsSync(base)) return false;
  const runs = fs
    .readdirSync(base)
    .filter((d) => fs.existsSync(path.join(base, d, "lockdown-report.json")))
    .sort()
    .reverse();
  for (const run of runs) {
    const report = JSON.parse(
      fs.readFileSync(path.join(base, run, "lockdown-report.json"), "utf8"),
    ) as { safe_to_cleanup?: boolean; trigger_present?: boolean; active_running_or_queued_jobs?: number };
    if (report.trigger_present && report.active_running_or_queued_jobs === 0) {
      return report.safe_to_cleanup === true;
    }
  }
  return false;
}

async function census(client: pg.Client): Promise<Record<string, number>> {
  const r = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL) AS active_return_items,
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL AND ${sqlExcludeBulkOrphanReturnItems("return_items")}) AS return_process_active_count,
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL AND package_id IS NOT NULL) AS package_scan_rows,
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL AND pallet_id IS NOT NULL AND package_id IS NULL) AS pallet_only_scan_rows,
      (SELECT COUNT(*)::int FROM public.return_items WHERE ${TARGET_WHERE}) AS bulk_orphan_target,
      (SELECT COUNT(*)::int FROM public.products) AS products,
      (SELECT COUNT(*)::int FROM public.expected_packages) AS expected_packages,
      (SELECT COUNT(*)::int FROM public.product_identifier_map WHERE deleted_at IS NULL) AS product_identifier_map_active,
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NOT NULL) AS soft_deleted_return_items_total
  `);
  return r.rows[0] as Record<string, number>;
}

async function verifyLockdown(client: pg.Client): Promise<{ ok: boolean; detail: Record<string, unknown> }> {
  const trig = await client.query(`
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'return_items' AND t.tgname = 'trg_return_items_block_synthetic_bulk_orphan_insert'
  `);
  const jobs = await client.query(`
    SELECT count(*)::int AS n FROM background_jobs WHERE status IN ('running', 'queued')
  `);
  const running = (jobs.rows[0] as { n: number }).n;
  return {
    ok: trig.rows.length > 0 && running === 0,
    detail: { trigger_present: trig.rows.length > 0, active_running_or_queued_jobs: running },
  };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = hasFlag("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  const blockers: string[] = [];

  if (!dbUrl.includes(STAGING_REF)) blockers.push(`staging ref guard failed (expected ${STAGING_REF})`);
  if (originalUrl && dbUrl === originalUrl) blockers.push("must not use original URL");
  if (dbUrl.includes(ORIGINAL_REF)) blockers.push("DB URL targets original");

  const approval = readApproval();
  if (!approval.ok) blockers.push(...approval.reasons);
  if (!latestLockdownSafe()) blockers.push("lockdown SAFE_TO_CLEANUP precondition not met");

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '600s'");

  const lockdown = await verifyLockdown(client);
  if (!lockdown.ok) blockers.push("live lockdown verify failed (trigger or running jobs)");

  const before = await census(client);
  if (before.bulk_orphan_target === 0) blockers.push("bulk_orphan_target already 0");

  const preimageRes = await client.query(`
    SELECT
      ri.id::text,
      ri.organization_id::text,
      ri.store_id::text,
      ri.expected_item_id::text,
      ri.package_id::text,
      ri.pallet_id::text,
      ri.product_id::text,
      ri.resolved_product_id::text,
      ri.resolved_catalog_product_id::text,
      ri.identifier_resolution_status,
      ri.identifier_resolution_confidence::text,
      ri.status,
      ri.sku,
      ri.fnsku,
      ri.asin,
      ri.created_at::text,
      ri.updated_at::text,
      ri.deleted_at::text
    FROM public.return_items ri
    WHERE ${TARGET_WHERE_RI}
    ORDER BY ri.id
  `);

  const preimagePath = path.join(outDir, "preimage-rows.json");
  fs.writeFileSync(preimagePath, JSON.stringify(preimageRes.rows, null, 2));

  const rollbackLines = preimageRes.rows.map(
    (r: { id: string; deleted_at: string | null; updated_at: string }) =>
      `UPDATE public.return_items SET deleted_at=${r.deleted_at ? `'${r.deleted_at}'` : "NULL"}, updated_at='${r.updated_at}' WHERE id='${r.id}'::uuid;`,
  );
  const rollbackPath = path.join(outDir, "rollback.sql");
  fs.writeFileSync(
    rollbackPath,
    [
      "-- RETURN-ITEMS-BULK-ORPHAN-REGRESSION-CLEANUP-STAGING rollback",
      `-- run_id: ${runId}`,
      `-- rows: ${preimageRes.rows.length}`,
      ...rollbackLines,
    ].join("\n"),
    "utf8",
  );

  if (apply && blockers.length) {
    await client.end();
    fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.map((b) => `- ${b}`).join("\n") + "\n");
    throw new Error(`Blocked: ${blockers.join("; ")}`);
  }

  let rowsSoftDeleted = 0;
  let executed = false;

  if (apply) {
    if (preimageRes.rows.length !== before.bulk_orphan_target) {
      throw new Error(
        `Preimage/census mismatch: preimage=${preimageRes.rows.length}, census=${before.bulk_orphan_target}`,
      );
    }
    await client.query("BEGIN");
    try {
      const upd = await client.query(`
        UPDATE public.return_items ri
        SET deleted_at = now(), updated_at = now()
        WHERE ${TARGET_WHERE_RI}
      `);
      rowsSoftDeleted = upd.rowCount ?? 0;
      if (rowsSoftDeleted !== before.bulk_orphan_target) {
        throw new Error(`Expected ${before.bulk_orphan_target} updates, got ${rowsSoftDeleted}`);
      }
      await client.query("COMMIT");
      executed = true;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  }

  const after = executed ? await census(client) : before;

  const hardDeleteCheck = await client.query(`
    SELECT COUNT(*)::int AS n FROM public.return_items ri
    WHERE ${TARGET_WHERE_RI.replace(/ri\./g, "ri.")}
  `);
  const targetStillActive = (hardDeleteCheck.rows[0] as { n: number }).n;

  const physicalRemaining =
    after.package_scan_rows + (after.pallet_only_scan_rows ?? 0);

  const parityOk =
    executed &&
    after.bulk_orphan_target === 0 &&
    after.expected_packages === before.expected_packages &&
    after.products === before.products &&
    after.product_identifier_map_active === before.product_identifier_map_active &&
    after.package_scan_rows === before.package_scan_rows &&
    rowsSoftDeleted === before.bulk_orphan_target;

  const safeToContinue = executed && parityOk && targetStillActive === 0;

  const manifest = {
    prompt: "RETURN-ITEMS-BULK-ORPHAN-REGRESSION-CLEANUP-STAGING",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: apply ? "execute" : "dry_run",
    approval_ok: approval.ok,
    lockdown_ok: lockdown.ok,
    target_predicate: TARGET_PREDICATE,
    BEFORE_COUNTS: before,
    ROWS_SOFT_DELETED: rowsSoftDeleted,
    AFTER_COUNTS: after,
    PHYSICAL_ROWS_REMAINING: {
      package_scan_rows: after.package_scan_rows,
      pallet_only_scan_rows: after.pallet_only_scan_rows ?? 0,
      combined: physicalRemaining,
    },
    return_process_active_count: after.return_process_active_count,
    return_process_active_count_before: before.return_process_active_count,
    ROLLBACK_PATH: rollbackPath.replace(process.cwd() + path.sep, "").replace(/\\/g, "/"),
    preimage_path: preimagePath.replace(process.cwd() + path.sep, "").replace(/\\/g, "/"),
    SAFE_TO_CONTINUE: safeToContinue ? "yes" : executed ? "no" : "pending_apply",
    tables_touched: executed ? ["return_items"] : [],
    hard_delete: false,
    blockers,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      "# RETURN-ITEMS-BULK-ORPHAN-REGRESSION-CLEANUP-STAGING",
      "",
      `| Field | Value |`,
      `|-------|-------|`,
      `| Mode | **${apply ? "execute" : "dry_run"}** |`,
      `| ROWS_SOFT_DELETED | **${rowsSoftDeleted}** |`,
      `| bulk_orphan_target after | **${after.bulk_orphan_target}** |`,
      `| Return Process active count | **${after.return_process_active_count}** (before ${before.return_process_active_count}) |`,
      `| Physical package scans | **${after.package_scan_rows}** |`,
      `| SAFE_TO_CONTINUE | **${manifest.SAFE_TO_CONTINUE}** |`,
    ].join("\n"),
    "utf8",
  );

  await client.end();
  console.log(
    JSON.stringify(
      {
        BEFORE_COUNTS: before,
        ROWS_SOFT_DELETED: rowsSoftDeleted,
        AFTER_COUNTS: after,
        PHYSICAL_ROWS_REMAINING: manifest.PHYSICAL_ROWS_REMAINING,
        return_process_active_count: after.return_process_active_count,
        ROLLBACK_PATH: rollbackPath,
        SAFE_TO_CONTINUE: manifest.SAFE_TO_CONTINUE,
        blockers,
      },
      null,
      2,
    ),
  );

  if (apply && !safeToContinue) process.exit(1);
  if (!apply && blockers.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
