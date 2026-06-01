/**
 * BULK-ORPHAN-RETURN-ITEMS-STAGING-REMEDIATION-EXECUTE
 *
 *   npx tsx scripts/bulk-orphan-return-items-staging-remediation-execute.ts --run-id=<UTC>
 *   npx tsx scripts/bulk-orphan-return-items-staging-remediation-execute.ts --run-id=<UTC> --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const APPROVAL_PATH =
  ".cursor/operator-approvals/bulk-orphan-return-items-staging-remediation-approval.md";
const OUT_BASE = ".cursor/audit-reports/bulk-orphan-return-items-staging-remediation-execute";
const TARGET_COUNT = 5333;

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
  if (!fs.existsSync(p)) {
    return { ok: false, reasons: ["approval_file_missing"] };
  }
  const text = fs.readFileSync(p, "utf8");
  if (!/APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text)) {
    reasons.push("APPROVED_TO_RUN_STAGING_not_true");
  }
  if (!/APPROVED_BULK_ORPHAN_RETURN_ITEMS_STAGING_REMEDIATION\s*=\s*true/i.test(text)) {
    reasons.push("APPROVED_BULK_ORPHAN_RETURN_ITEMS_STAGING_REMEDIATION_not_true");
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
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL AND package_id IS NOT NULL) AS package_scan_rows,
      (SELECT COUNT(*)::int FROM public.return_items WHERE ${TARGET_WHERE}) AS bulk_orphan_target,
      (SELECT COUNT(*)::int FROM public.products) AS products,
      (SELECT COUNT(*)::int FROM public.expected_packages) AS expected_packages,
      (SELECT COUNT(*)::int FROM public.product_identifier_map WHERE deleted_at IS NULL) AS product_identifier_map_active,
      (SELECT COUNT(*)::int FROM public.claim_cases) AS claim_cases
  `);
  return r.rows[0] as Record<string, number>;
}

async function epPattern(client: pg.Client): Promise<
  Array<{ expected_item_id: string; build_source: string; ri_count: number }>
> {
  const r = await client.query(`
    SELECT ep.id::text AS expected_item_id, ep.build_source, COUNT(*)::int AS ri_count
    FROM public.return_items ri
    JOIN public.expected_packages ep ON ep.id = ri.expected_item_id
    WHERE ${TARGET_WHERE_RI}
    GROUP BY ep.id, ep.build_source
    ORDER BY ri_count DESC
  `);
  return r.rows as Array<{ expected_item_id: string; build_source: string; ri_count: number }>;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = hasFlag("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl.includes(STAGING_REF)) {
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF})`);
  }

  const approval = readApproval();
  if (apply && !approval.ok) {
    throw new Error(`Execute blocked: ${approval.reasons.join(", ")}`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");

  const before = await census(client);
  const epRows = await epPattern(client);
  const epSum = epRows.reduce((a, r) => a + r.ri_count, 0);
  const allReceiveAllocated = epRows.every((r) => r.build_source === "receive_allocated");
  const epCountOk = epRows.length === 5 && epSum === TARGET_COUNT && allReceiveAllocated;
  const targetOk = before.bulk_orphan_target === TARGET_COUNT;

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
      "-- BULK-ORPHAN-RETURN-ITEMS-STAGING-REMEDIATION rollback",
      `-- run_id: ${runId}`,
      `-- rows: ${preimageRes.rows.length}`,
      ...rollbackLines,
    ].join("\n"),
    "utf8",
  );

  let remediationExecuted = false;
  let rowsUpdated = 0;

  if (apply && targetOk && epCountOk) {
    await client.query("BEGIN");
    try {
      const upd = await client.query(`
        UPDATE public.return_items ri
        SET deleted_at = now(), updated_at = now()
        WHERE ${TARGET_WHERE_RI}
      `);
      rowsUpdated = upd.rowCount ?? 0;
      if (rowsUpdated !== TARGET_COUNT) {
        throw new Error(`Expected ${TARGET_COUNT} updates, got ${rowsUpdated}`);
      }
      await client.query("COMMIT");
      remediationExecuted = true;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  }

  const after = apply && remediationExecuted ? await census(client) : before;

  const manifest = {
    prompt: "BULK-ORPHAN-RETURN-ITEMS-STAGING-REMEDIATION-EXECUTE",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: apply ? "execute" : "dry_run",
    approval_ok: approval.ok,
    target_predicate: TARGET_PREDICATE,
    target_count_expected: TARGET_COUNT,
    target_count_actual: before.bulk_orphan_target,
    target_count_ok: targetOk,
    ep_pattern_rows: epRows.length,
    ep_pattern_ok: epCountOk,
    ep_pattern: epRows,
    remediation_executed: remediationExecuted,
    rows_updated: rowsUpdated,
    before_counts: before,
    after_counts: after,
    tables_touched: remediationExecuted ? ["return_items"] : [],
    preimage_path: preimagePath.replace(process.cwd() + path.sep, "").replace(/\\/g, "/"),
    rollback_sql: rollbackPath.replace(process.cwd() + path.sep, "").replace(/\\/g, "/"),
    soft_delete_metadata: "deleted_at only — return_items has no deletion_reason column",
    next_view_verify_prompt:
      "INVENTORY-VIEWS-POST-BULK-ORPHAN-REMEDIATION-VERIFY — re-run v_scanned_items_counted / v_inventory_item_status counts on staging; confirm physical scan totals match 3 package rows only",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      "# BULK-ORPHAN-RETURN-ITEMS-STAGING-REMEDIATION-EXECUTE",
      "",
      "## APPROVAL",
      `- file: \`${APPROVAL_PATH}\``,
      `- ok: **${approval.ok}**`,
      `- executed: **${remediationExecuted}**`,
      "",
      "## TARGET_PREDICATE",
      "```sql",
      TARGET_PREDICATE,
      "```",
      "",
      "## BEFORE_COUNTS",
      "| metric | count |",
      "|--------|------:|",
      ...Object.entries(before).map(([k, v]) => `| ${k} | ${v} |`),
      "",
      "## PREIMAGE_PATH",
      `- \`${manifest.preimage_path}\``,
      `- rows: ${preimageRes.rows.length}`,
      "",
      "## REMEDIATION_EXECUTED",
      `- **${remediationExecuted ? "yes" : "no"}** (${rowsUpdated} rows soft-deleted via \`deleted_at\`)`,
      "",
      "## AFTER_COUNTS",
      "| metric | count |",
      "|--------|------:|",
      ...Object.entries(after).map(([k, v]) => `| ${k} | ${v} |`),
      "",
      "## TABLES_TOUCHED",
      remediationExecuted ? "- `return_items` (soft-delete only)" : "- none (dry-run or blocked)",
      "",
      "## ROLLBACK_SQL",
      `- \`${manifest.rollback_sql}\``,
      "",
      "## EP pattern verification",
      `- distinct EP children: ${epRows.length} (expected 5)`,
      `- all receive_allocated: ${allReceiveAllocated}`,
      `- sum RI count: ${epSum}`,
      "",
      "## NEXT_VIEW_VERIFY_PROMPT",
      `\`${manifest.next_view_verify_prompt}\``,
    ].join("\n"),
    "utf8",
  );

  await client.end();
  console.log(JSON.stringify(manifest, null, 2));

  if (!targetOk || !epCountOk) {
    throw new Error(
      `Pre-apply verification failed: target=${before.bulk_orphan_target}, ep_rows=${epRows.length}, ep_sum=${epSum}`,
    );
  }
  if (apply && !remediationExecuted) {
    throw new Error("Apply requested but remediation did not execute");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
