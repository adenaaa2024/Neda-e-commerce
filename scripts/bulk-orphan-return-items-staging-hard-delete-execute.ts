/**
 * BULK-ORPHAN-RETURN-ITEMS-STAGING-HARD-DELETE
 *
 *   npx tsx scripts/bulk-orphan-return-items-staging-hard-delete-execute.ts --run-id=<UTC>
 *   npx tsx scripts/bulk-orphan-return-items-staging-hard-delete-execute.ts --run-id=<UTC> --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const APPROVAL_PATH =
  ".cursor/operator-approvals/bulk-orphan-return-items-staging-hard-delete-approval.md";
const OUT_BASE = ".cursor/audit-reports/bulk-orphan-return-items-staging-hard-delete";
const TARGET_COUNT = 5333;

const TARGET_PREDICATE = `deleted_at IS NOT NULL
AND expected_item_id IS NOT NULL
AND package_id IS NULL
AND pallet_id IS NULL`;

const TARGET_WHERE = `
  deleted_at IS NOT NULL
  AND expected_item_id IS NOT NULL
  AND package_id IS NULL
  AND pallet_id IS NULL
`;

const TARGET_WHERE_RI = `
  ri.deleted_at IS NOT NULL
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
  if (!/APPROVED_BULK_ORPHAN_RETURN_ITEMS_STAGING_HARD_DELETE\s*=\s*true/i.test(text)) {
    reasons.push("APPROVED_BULK_ORPHAN_RETURN_ITEMS_STAGING_HARD_DELETE_not_true");
  }
  if (!new RegExp(`TARGET_SUPABASE_REF\\s*=\\s*${STAGING_REF}`, "i").test(text)) {
    reasons.push("TARGET_SUPABASE_REF_mismatch");
  }
  return { ok: reasons.length === 0, reasons };
}

type VerifyCounts = {
  total: number;
  active: number;
  active_bulk_orphan: number;
  soft_deleted: number;
  active_with_package: number;
  hard_delete_target: number;
  products: number;
  expected_packages: number;
  product_identifier_map_active: number;
  v_scanned_sum: number;
};

async function verifyCounts(client: pg.Client): Promise<VerifyCounts> {
  const r = await client.query(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE deleted_at IS NULL)::int AS active,
      count(*) FILTER (
        WHERE deleted_at IS NULL
          AND expected_item_id IS NOT NULL
          AND package_id IS NULL
          AND pallet_id IS NULL
      )::int AS active_bulk_orphan,
      count(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS soft_deleted,
      count(*) FILTER (WHERE package_id IS NOT NULL AND deleted_at IS NULL)::int AS active_with_package,
      count(*) FILTER (WHERE ${TARGET_WHERE})::int AS hard_delete_target,
      (SELECT count(*)::int FROM public.products) AS products,
      (SELECT count(*)::int FROM public.expected_packages) AS expected_packages,
      (SELECT count(*)::int FROM public.product_identifier_map WHERE deleted_at IS NULL) AS product_identifier_map_active,
      (SELECT coalesce(sum(total_scanned), 0)::numeric FROM public.v_scanned_items_counted) AS v_scanned_sum
    FROM public.return_items
  `);
  const row = r.rows[0] as Record<string, unknown>;
  return {
    total: Number(row.total),
    active: Number(row.active),
    active_bulk_orphan: Number(row.active_bulk_orphan),
    soft_deleted: Number(row.soft_deleted),
    active_with_package: Number(row.active_with_package),
    hard_delete_target: Number(row.hard_delete_target),
    products: Number(row.products),
    expected_packages: Number(row.expected_packages),
    product_identifier_map_active: Number(row.product_identifier_map_active),
    v_scanned_sum: Number(row.v_scanned_sum),
  };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl.includes(STAGING_REF)) {
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF})`);
  }
  if (dbUrl.includes(ORIGINAL_REF)) {
    throw new Error("Original ref in connection URL — blocked");
  }

  const approval = readApproval();
  if (apply && !approval.ok) {
    throw new Error(`Execute blocked: ${approval.reasons.join(", ")}`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");

  const before = await verifyCounts(client);

  const blockers: string[] = [];
  if (before.hard_delete_target !== TARGET_COUNT) {
    blockers.push(`hard_delete_target=${before.hard_delete_target} expected ${TARGET_COUNT}`);
  }
  if (before.active_bulk_orphan !== 0) {
    blockers.push(`active_bulk_orphan=${before.active_bulk_orphan} expected 0`);
  }
  if (before.active_with_package !== 3) {
    blockers.push(`active_with_package=${before.active_with_package} expected 3`);
  }
  if (before.products !== 17033) {
    blockers.push(`products=${before.products} expected 17033`);
  }
  if (before.expected_packages !== 9459) {
    blockers.push(`expected_packages=${before.expected_packages} expected 9459`);
  }
  if (before.product_identifier_map_active !== 16811) {
    blockers.push(`product_identifier_map=${before.product_identifier_map_active} expected 16811`);
  }

  const preimageRes = await client.query(`
    SELECT ri.*
    FROM public.return_items ri
    WHERE ${TARGET_WHERE_RI}
    ORDER BY ri.id
  `);

  const preimagePath = path.join(outDir, "preimage-rows.json");
  fs.writeFileSync(preimagePath, JSON.stringify(preimageRes.rows, null, 2));

  if (preimageRes.rows.length !== TARGET_COUNT) {
    blockers.push(`preimage_rows=${preimageRes.rows.length} expected ${TARGET_COUNT}`);
  }

  const deps = await client.query(`
    SELECT
      (SELECT count(*)::int FROM public.claim_lines cl
         JOIN public.return_items ri ON ri.id = cl.return_item_id
         WHERE ${TARGET_WHERE_RI}) AS claim_lines_on_target,
      (SELECT count(*)::int FROM public.claim_submissions cs
         JOIN public.return_items ri ON ri.id = cs.return_id
         WHERE ${TARGET_WHERE_RI}) AS claim_submissions_on_target
  `);
  const depRow = deps.rows[0] as { claim_lines_on_target: number; claim_submissions_on_target: number };
  if (depRow.claim_lines_on_target > 0 || depRow.claim_submissions_on_target > 0) {
    blockers.push(
      `dependencies claim_lines=${depRow.claim_lines_on_target} claim_submissions=${depRow.claim_submissions_on_target}`,
    );
  }

  let rowsHardDeleted = 0;
  let executed = false;

  if (apply && blockers.length === 0 && approval.ok) {
    await client.query("BEGIN");
    try {
      const del = await client.query(`
        DELETE FROM public.return_items ri
        WHERE ${TARGET_WHERE_RI}
      `);
      rowsHardDeleted = del.rowCount ?? 0;
      if (rowsHardDeleted !== TARGET_COUNT) {
        throw new Error(`Expected ${TARGET_COUNT} deletes, got ${rowsHardDeleted}`);
      }
      await client.query("COMMIT");
      executed = true;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  }

  const after = executed ? await verifyCounts(client) : before;

  const afterBlockers: string[] = [];
  if (executed) {
    if (after.total !== 33) afterBlockers.push(`total=${after.total} expected 33`);
    if (after.active !== 33) afterBlockers.push(`active=${after.active} expected 33`);
    if (after.hard_delete_target !== 0) {
      afterBlockers.push(`hard_delete_target=${after.hard_delete_target} expected 0`);
    }
    if (after.soft_deleted !== 0) afterBlockers.push(`soft_deleted=${after.soft_deleted} expected 0`);
    if (after.active_with_package !== 3) {
      afterBlockers.push(`active_with_package=${after.active_with_package} expected 3`);
    }
    if (after.expected_packages !== before.expected_packages) {
      afterBlockers.push("expected_packages changed");
    }
    if (after.products !== before.products) afterBlockers.push("products changed");
    if (after.product_identifier_map_active !== before.product_identifier_map_active) {
      afterBlockers.push("product_identifier_map changed");
    }
    if (after.v_scanned_sum !== 3) afterBlockers.push(`v_scanned_sum=${after.v_scanned_sum} expected 3`);
  }

  const safe = executed && blockers.length === 0 && afterBlockers.length === 0;

  const report = [
    "# BULK-ORPHAN-RETURN-ITEMS-STAGING-HARD-DELETE",
    "",
    `Run: \`${runId}\` · Staging: \`${STAGING_REF}\``,
    "",
    "## BEFORE_COUNTS",
    "",
    "| metric | value |",
    "|--------|------:|",
    ...Object.entries(before).map(([k, v]) => `| ${k} | ${v} |`),
    "",
    "## ROWS_HARD_DELETED",
    "",
    String(rowsHardDeleted),
    "",
    "## AFTER_COUNTS",
    "",
    "| metric | value |",
    "|--------|------:|",
    ...Object.entries(after).map(([k, v]) => `| ${k} | ${v} |`),
    "",
    "## PREIMAGE_PATH",
    "",
    preimagePath.replace(process.cwd() + path.sep, "").replace(/\\/g, "/"),
    "",
    "## TABLES_TOUCHED",
    "",
    executed ? "- `return_items` (hard delete only)" : "- none",
    "",
    "## SAFE_TO_CONTINUE",
    "",
    safe ? "**yes**" : "**no**",
    "",
    ...(blockers.length ? ["## Pre blockers", "", ...blockers.map((b) => `- ${b}`)] : []),
    ...(afterBlockers.length ? ["## Post blockers", "", ...afterBlockers.map((b) => `- ${b}`)] : []),
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "HARD_DELETE_RESULT.md"), report + "\n");
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "BULK-ORPHAN-RETURN-ITEMS-STAGING-HARD-DELETE",
        run_id: runId,
        staging_ref: STAGING_REF,
        executed,
        rows_hard_deleted: rowsHardDeleted,
        before,
        after,
        preimage_path: preimagePath.replace(process.cwd() + path.sep, "").replace(/\\/g, "/"),
        tables_touched: executed ? ["return_items"] : [],
        safe_to_continue: safe,
        blockers: [...blockers, ...afterBlockers],
      },
      null,
      2,
    ),
  );

  await client.end();
  console.log(JSON.stringify({ safe_to_continue: safe, rowsHardDeleted, before, after, blockers: [...blockers, ...afterBlockers] }, null, 2));

  if (blockers.length && apply) process.exit(1);
  if (apply && !executed) process.exit(1);
  if (executed && afterBlockers.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
