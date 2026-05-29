/**
 * REMOVAL-TRACKING-NORMALIZATION-FIX-EXECUTE — staging operational cleanup
 *
 *   npx tsx scripts/removal-tracking-normalization-fix-execute.ts
 *   npx tsx scripts/removal-tracking-normalization-fix-execute.ts --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import {
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";
import { normalizeRemovalTrackingOperational } from "../lib/pipeline/removal-tracking-normalize";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const APPROVAL_PATH = ".cursor/operator-approvals/removal-tracking-normalization-fix-approval.md";
const OUT_BASE = ".cursor/audit-reports/removal-tracking-normalization-fix-execute";

type DirtyRow = {
  id: string;
  tracking_number: string | null;
  raw_row: unknown;
  normalize_status: string;
  operational: string | null;
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

function readApproval(): { valid: boolean; raw: Record<string, string> } {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const runVal = /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text);
  const fixVal = /APPROVED_REMOVAL_TRACKING_NORMALIZATION_FIX\s*=\s*true/i.test(text);
  return {
    valid: runVal && fixVal,
    raw: {
      APPROVED_TO_RUN_STAGING: runVal ? "true" : "false",
      APPROVED_REMOVAL_TRACKING_NORMALIZATION_FIX: fixVal ? "true" : "false",
    },
  };
}

async function countProbes(client: pg.Client): Promise<Record<string, number>> {
  const r = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM public.amazon_removal_shipments
       WHERE tracking_number IS NOT NULL AND position(',' IN tracking_number) > 0) AS arms_comma,
      (SELECT COUNT(*)::int FROM public.amazon_removal_shipments s,
         LATERAL public.normalize_removal_tracking_operational(s.tracking_number) n
       WHERE s.tracking_number IS NOT NULL AND n.status = 'multi_conflict') AS arms_multi_conflict,
      (SELECT COUNT(*)::int FROM public.amazon_removals
       WHERE tracking_number IS NOT NULL AND position(',' IN tracking_number) > 0) AS ar_comma,
      (SELECT COUNT(*)::int FROM public.expected_packages
       WHERE tracking_number IS NOT NULL AND position(',' IN tracking_number) > 0) AS ep_comma
  `);
  return r.rows[0] as Record<string, number>;
}

async function fetchDirtyShipmentRows(client: pg.Client): Promise<DirtyRow[]> {
  const r = await client.query(`
    SELECT s.id::text, s.tracking_number, s.raw_row,
      n.status AS normalize_status, n.operational
    FROM public.amazon_removal_shipments s
    CROSS JOIN LATERAL public.normalize_removal_tracking_operational(s.tracking_number) n
    WHERE s.tracking_number IS NOT NULL
      AND (
        position(',' IN s.tracking_number) > 0
        OR n.status IN ('deduped_repeated', 'multi_conflict')
        OR (n.operational IS NOT NULL AND s.tracking_number IS DISTINCT FROM n.operational)
      )
  `);
  return r.rows as DirtyRow[];
}

async function ensureSqlNormalizer(client: pg.Client): Promise<void> {
  const exists = await client.query(
    `SELECT 1 FROM pg_proc WHERE proname = 'normalize_removal_tracking_operational' LIMIT 1`,
  );
  if (exists.rowCount) return;

  const sql = fs.readFileSync(
    path.join(
      process.cwd(),
      "supabase/migrations/20260827160000_expected_packages_tracking_group_allocation.sql",
    ),
    "utf8",
  );
  const fnMatch = sql.match(
    /CREATE OR REPLACE FUNCTION public\.normalize_removal_tracking_operational[\s\S]*?\$norm\$;[\s\S]*?END;\s*\$norm\$;/,
  );
  if (!fnMatch) throw new Error("Could not extract normalize_removal_tracking_operational from migration");
  await client.query(fnMatch[0]);
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const approval = readApproval();
  const blockers: string[] = [];

  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);
  if (!approval.valid) blockers.push("Approval flags not both true");

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset");
  else {
    if (!supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
      blockers.push(`DB URL must target staging ${STAGING_REF}`);
    }
    if (dbUrl.includes(ORIGINAL_REF)) blockers.push("DB URL targets original — forbidden");
  }

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof",
      "",
      "| Flag | Value |",
      "|------|-------|",
      `| APPROVED_TO_RUN_STAGING | ${approval.raw.APPROVED_TO_RUN_STAGING} |`,
      `| APPROVED_REMOVAL_TRACKING_NORMALIZATION_FIX | ${approval.raw.APPROVED_REMOVAL_TRACKING_NORMALIZATION_FIX} |`,
      `| valid | **${approval.valid}** |`,
      "",
      "Staging only. No Amazon API. No expected_packages rebuild in this pass.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "code-change-summary.md"),
    [
      "# Code change summary",
      "",
      "| File | Change |",
      "|------|--------|",
      "| `lib/pipeline/removal-tracking-normalize.ts` | Operational normalize helper (dedupe / multi_conflict) |",
      "| `lib/import-sync-mappers.ts` | `mapRowToAmazonRemovalShipment`, `mapRowToAmazonRemoval` use helper |",
      "| `lib/pipeline/removal-shipment-archive-key.ts` | Business key on normalized tracking |",
      "| `scripts/verify-removal-tracking-normalize.ts` | Unit verify script |",
      "| `scripts/removal-tracking-normalization-fix-execute.ts` | This execute script |",
      "| `supabase/migrations/20260827160000_*` | SQL `normalize_removal_tracking_operational` (shared with allocation migration) |",
    ].join("\n") + "\n",
  );

  if (!apply || blockers.length) {
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      blockers.length
        ? blockers.map((b) => `- ${b}`).join("\n") + "\n"
        : "- Dry-run only; pass `--apply` to run staging cleanup.\n",
    );
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify({ run_id: runId, ok: !blockers.length, apply: false, blockers }, null, 2) + "\n",
    );
    console.log(JSON.stringify({ ok: !blockers.length, outDir, apply: false, blockers }, null, 2));
    return;
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");
  await ensureSqlNormalizer(client);

  const before = await countProbes(client);
  const dirtyRows = await fetchDirtyShipmentRows(client);

  fs.writeFileSync(
    path.join(outDir, "preimage-dirty-tracking.json"),
    JSON.stringify(
      {
        run_id: runId,
        captured_at: new Date().toISOString(),
        row_count: dirtyRows.length,
        rows: dirtyRows,
      },
      null,
      2,
    ),
  );

  const rollbackLines = [
    "-- Rollback: restore tracking_number from preimage-dirty-tracking.json",
    "-- UPDATE amazon_removal_shipments SET tracking_number = <before> WHERE id = <id>;",
  ];
  for (const row of dirtyRows.slice(0, 500)) {
    const tn = row.tracking_number?.replace(/'/g, "''") ?? "";
    rollbackLines.push(
      `UPDATE public.amazon_removal_shipments SET tracking_number = '${tn}' WHERE id = '${row.id}'::uuid;`,
    );
  }
  fs.writeFileSync(path.join(outDir, "rollback.sql"), rollbackLines.join("\n") + "\n");

  let armsUpdated = 0;
  let armsSkippedConflict = 0;

  await client.query("BEGIN");
  try {
    const upd = await client.query(`
      WITH targets AS (
        SELECT s.id, n.operational, n.status
        FROM public.amazon_removal_shipments s
        CROSS JOIN LATERAL public.normalize_removal_tracking_operational(s.tracking_number) n
        WHERE s.tracking_number IS NOT NULL
          AND n.status = 'deduped_repeated'
          AND n.operational IS NOT NULL
          AND s.tracking_number IS DISTINCT FROM n.operational
      )
      UPDATE public.amazon_removal_shipments ars
      SET tracking_number = t.operational
      FROM targets t
      WHERE ars.id = t.id
      RETURNING ars.id
    `);
    armsUpdated = upd.rowCount ?? 0;

    const skip = await client.query(`
      SELECT COUNT(*)::int AS c FROM public.amazon_removal_shipments s,
        LATERAL public.normalize_removal_tracking_operational(s.tracking_number) n
      WHERE s.tracking_number IS NOT NULL AND n.status = 'multi_conflict'
    `);
    armsSkippedConflict = (skip.rows[0] as { c: number }).c;

    const arUpd = await client.query(`
      WITH targets AS (
        SELECT r.id, n.operational
        FROM public.amazon_removals r
        CROSS JOIN LATERAL public.normalize_removal_tracking_operational(r.tracking_number) n
        WHERE r.tracking_number IS NOT NULL
          AND n.status IN ('single', 'deduped_repeated')
          AND n.operational IS NOT NULL
          AND r.tracking_number IS DISTINCT FROM n.operational
      )
      UPDATE public.amazon_removals ar
      SET tracking_number = t.operational
      FROM targets t
      WHERE ar.id = t.id
      RETURNING ar.id
    `);

    await client.query("COMMIT");

    const after = await countProbes(client);

    fs.writeFileSync(
      path.join(outDir, "cleanup-result.md"),
      [
        "# Cleanup result",
        "",
        "| Metric | Before | After |",
        "|--------|-------:|------:|",
        `| arms comma tracking | ${before.arms_comma} | ${after.arms_comma} |`,
        `| arms multi_conflict (unchanged op) | ${before.arms_multi_conflict} | ${after.arms_multi_conflict} |`,
        `| amazon_removals comma | ${before.ar_comma} | ${after.ar_comma} |`,
        `| expected_packages comma | ${before.ep_comma} | ${after.ep_comma} |`,
        "",
        `- Shipment rows updated: **${armsUpdated}**`,
        `- Detail rows updated: **${arUpd.rowCount ?? 0}**`,
        `- Multi-conflict rows left for manual (operational not overwritten): **${armsSkippedConflict}**`,
        "- raw_row / raw_data columns: **not modified**",
      ].join("\n") + "\n",
    );

    fs.writeFileSync(
      path.join(outDir, "smoke-probes.md"),
      [
        "# Smoke probes",
        "",
        "```json",
        JSON.stringify({ before, after, arms_updated: armsUpdated, multi_conflict: armsSkippedConflict }, null, 2),
        "```",
        "",
        "## TS helper sample",
        "",
        "```json",
        JSON.stringify(normalizeRemovalTrackingOperational("2320305295, 2320305295"), null, 2),
        "```",
      ].join("\n") + "\n",
    );

    const execBlockers: string[] = [];
    if (after.arms_comma > 0) execBlockers.push(`arms_comma_after=${after.arms_comma}`);
    if (after.arms_multi_conflict > 0 && after.arms_multi_conflict !== before.arms_multi_conflict) {
      execBlockers.push(`unexpected_multi_conflict_change`);
    }

    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      execBlockers.length ? execBlockers.map((b) => `- ${b}`).join("\n") + "\n" : "- None\n",
    );

    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify(
        {
          run_id: runId,
          ok: execBlockers.length === 0,
          before,
          after,
          arms_updated: armsUpdated,
          ar_updated: arUpd.rowCount ?? 0,
          multi_conflict: armsSkippedConflict,
          preimage_count: dirtyRows.length,
          blockers: execBlockers,
        },
        null,
        2,
      ) + "\n",
    );

    console.log(
      JSON.stringify(
        {
          ok: execBlockers.length === 0,
          outDir,
          before_comma: before.arms_comma,
          after_comma: after.arms_comma,
          updated: armsUpdated,
          multi_conflict: armsSkippedConflict,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
