/**
 * RETURN-ITEMS-BULK-ORPHAN-FINAL-CLEANUP-587-STAGING
 *
 *   npx tsx scripts/return-items-bulk-orphan-final-cleanup-587-staging-execute.ts --run-id=<UTC>
 *   npx tsx scripts/return-items-bulk-orphan-final-cleanup-587-staging-execute.ts --run-id=<UTC> --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";
import { sqlExcludeBulkOrphanReturnItems } from "../lib/return-item-physical-scan";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const APPROVAL_PATH =
  ".cursor/operator-approvals/return-items-bulk-orphan-final-cleanup-587-staging-approval.md";
const OUT_BASE = ".cursor/audit-reports/return-items-bulk-orphan-final-cleanup-587-staging";
const EXPECTED_APPROX = 587;

const TARGET_PREDICATE = `deleted_at IS NULL
AND expected_item_id IS NOT NULL
AND package_id IS NULL
AND pallet_id IS NULL`;

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
  if (!/APPROVED_RETURN_ITEMS_BULK_ORPHAN_FINAL_CLEANUP_587\s*=\s*true/i.test(text)) {
    reasons.push("APPROVED_RETURN_ITEMS_BULK_ORPHAN_FINAL_CLEANUP_587_not_true");
  }
  if (!new RegExp(`TARGET_SUPABASE_REF\\s*=\\s*${STAGING_REF}`, "i").test(text)) {
    reasons.push("TARGET_SUPABASE_REF_mismatch");
  }
  return { ok: reasons.length === 0, reasons };
}

async function census(client: pg.Client): Promise<Record<string, number>> {
  const r = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL) AS active_return_items,
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL AND ${sqlExcludeBulkOrphanReturnItems("return_items")}) AS return_process_ui_count,
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL AND expected_item_id IS NULL AND package_id IS NULL AND pallet_id IS NULL) AS legacy_no_expected_no_physical,
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL AND expected_item_id IS NULL AND package_id IS NOT NULL) AS legacy_no_expected_with_package,
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL AND package_id IS NOT NULL) AS package_scan_rows,
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL AND pallet_id IS NOT NULL AND package_id IS NULL) AS pallet_only_scan_rows,
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL AND expected_item_id IS NOT NULL AND package_id IS NOT NULL) AS expected_with_physical_scan,
      (SELECT COUNT(*)::int FROM public.return_items ri WHERE ${TARGET_WHERE_RI}) AS bulk_orphan_target,
      (SELECT COUNT(*)::int FROM public.products) AS products,
      (SELECT COUNT(*)::int FROM public.expected_packages) AS expected_packages,
      (SELECT COUNT(*)::int FROM public.product_identifier_map WHERE deleted_at IS NULL) AS product_identifier_map_active,
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NOT NULL) AS soft_deleted_return_items_total
  `);
  return r.rows[0] as Record<string, number>;
}

async function verifyPreconditions(client: pg.Client): Promise<{ ok: boolean; detail: Record<string, unknown> }> {
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

function legacyBreakdown(counts: Record<string, number>) {
  const legacyTotal =
    counts.legacy_no_expected_no_physical + counts.legacy_no_expected_with_package;
  return {
    legacy_return_process_rows_total: legacyTotal,
    legacy_no_expected_no_physical: counts.legacy_no_expected_no_physical,
    legacy_no_expected_with_package: counts.legacy_no_expected_with_package,
    expected_with_physical_scan: counts.expected_with_physical_scan,
    explanation:
      "Return Process UI count (return_process_ui_count) excludes bulk orphans via OR filter. Legacy rows are active return_items without expected_item_id — split into unanchored (no package/pallet) vs package-attached imports/scans.",
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

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '600s'");

  const preconditions = await verifyPreconditions(client);
  if (!preconditions.ok) blockers.push("preconditions failed (trigger or running jobs)");

  const before = await census(client);
  if (before.bulk_orphan_target === 0) blockers.push("bulk_orphan_target already 0");

  const preimageRes = await client.query(`
    SELECT
      ri.id::text, ri.organization_id::text, ri.store_id::text, ri.expected_item_id::text,
      ri.package_id::text, ri.pallet_id::text, ri.product_id::text,
      ri.resolved_product_id::text, ri.resolved_catalog_product_id::text,
      ri.identifier_resolution_status, ri.identifier_resolution_confidence::text,
      ri.status, ri.sku, ri.fnsku, ri.asin,
      ri.created_at::text, ri.updated_at::text, ri.deleted_at::text
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
      "-- RETURN-ITEMS-BULK-ORPHAN-FINAL-CLEANUP-587-STAGING rollback",
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
  const legacyBefore = legacyBreakdown(before);
  const legacyAfter = legacyBreakdown(after);

  const physicalRemaining = {
    package_scan_rows: after.package_scan_rows,
    pallet_only_scan_rows: after.pallet_only_scan_rows,
    combined: after.package_scan_rows + after.pallet_only_scan_rows,
  };

  const parityOk =
    executed &&
    after.bulk_orphan_target === 0 &&
    after.expected_packages === before.expected_packages &&
    after.products === before.products &&
    after.product_identifier_map_active === before.product_identifier_map_active &&
    after.package_scan_rows === before.package_scan_rows &&
    after.pallet_only_scan_rows === before.pallet_only_scan_rows &&
    rowsSoftDeleted === before.bulk_orphan_target;

  const safeToContinue = executed && parityOk;

  const manifest = {
    prompt: "RETURN-ITEMS-BULK-ORPHAN-FINAL-CLEANUP-587-STAGING",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: apply ? "execute" : "dry_run",
    expected_approx_count: EXPECTED_APPROX,
    census_vs_expected_delta: before.bulk_orphan_target - EXPECTED_APPROX,
    preconditions: preconditions.detail,
    target_predicate: TARGET_PREDICATE,
    BEFORE_COUNTS: before,
    ROWS_SOFT_DELETED: rowsSoftDeleted,
    AFTER_COUNTS: after,
    LEGACY_RETURN_PROCESS_ROWS: legacyAfter,
    LEGACY_RETURN_PROCESS_ROWS_BEFORE: legacyBefore,
    return_process_ui_count_after: after.return_process_ui_count,
    return_process_ui_count_before: before.return_process_ui_count,
    PHYSICAL_ROWS_REMAINING: physicalRemaining,
    ROLLBACK_PATH: rollbackPath.replace(process.cwd() + path.sep, "").replace(/\\/g, "/"),
    preimage_path: preimagePath.replace(process.cwd() + path.sep, "").replace(/\\/g, "/"),
    SAFE_TO_CONTINUE: safeToContinue ? "yes" : executed ? "no" : "pending_apply",
    hard_delete: false,
    blockers,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      "# RETURN-ITEMS-BULK-ORPHAN-FINAL-CLEANUP-587-STAGING",
      "",
      "| Field | Value |",
      "|-------|-------|",
      `| Census (expected ~${EXPECTED_APPROX}) | **${before.bulk_orphan_target}** |`,
      `| ROWS_SOFT_DELETED | **${rowsSoftDeleted}** |`,
      `| bulk_orphan_target after | **${after.bulk_orphan_target}** |`,
      `| Return Process UI count | **${after.return_process_ui_count}** (before ${before.return_process_ui_count}) |`,
      `| Legacy no-expected rows | **${legacyAfter.legacy_return_process_rows_total}** |`,
      `| Physical scans remaining | **${physicalRemaining.combined}** |`,
      `| SAFE_TO_CONTINUE | **${manifest.SAFE_TO_CONTINUE}** |`,
      "",
      "## Legacy / Return Process breakdown",
      "",
      legacyAfter.explanation,
      "",
      `- legacy_no_expected_no_physical: ${legacyAfter.legacy_no_expected_no_physical}`,
      `- legacy_no_expected_with_package: ${legacyAfter.legacy_no_expected_with_package}`,
      `- expected_with_physical_scan: ${legacyAfter.expected_with_physical_scan}`,
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
        LEGACY_RETURN_PROCESS_ROWS: legacyAfter,
        PHYSICAL_ROWS_REMAINING: physicalRemaining,
        ROLLBACK_PATH: rollbackPath,
        SAFE_TO_CONTINUE: manifest.SAFE_TO_CONTINUE,
        census_vs_expected_587: before.bulk_orphan_target,
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
