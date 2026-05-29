/**
 * REMOVAL-EXPECTED-ALLOCATION-FIX-EXECUTE — grouped rebuild + verify (staging)
 *
 *   npx tsx scripts/removal-expected-allocation-fix-execute.ts
 *   npx tsx scripts/removal-expected-allocation-fix-execute.ts --apply
 *   npx tsx scripts/removal-expected-allocation-fix-execute.ts --apply --skip-migration
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import {
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const APPROVAL_PATH = ".cursor/operator-approvals/removal-expected-allocation-fix-approval.md";
const TRACKING_APPROVAL_PATH =
  ".cursor/operator-approvals/removal-tracking-normalization-fix-approval.md";
const MIGRATION_PATH =
  "supabase/migrations/20260827160000_expected_packages_tracking_group_allocation.sql";

const OUT_BASE = ".cursor/audit-reports/removal-expected-allocation-fix-execute";

type RebuildResult = {
  detail_lines_in_scope: string;
  matched_rows_upserted: string;
  remainder_rows_upserted: string;
  overflow_lines: string;
  obsolete_rows_deleted: string;
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

function readApproval(file: string, flags: string[]): { valid: boolean; raw: Record<string, string> } {
  const text = fs.readFileSync(path.join(process.cwd(), file), "utf8");
  const raw: Record<string, string> = {};
  let valid = true;
  for (const flag of flags) {
    const ok = new RegExp(`${flag}\\s*=\\s*true`, "i").test(text);
    raw[flag] = ok ? "true" : "false";
    if (!ok) valid = false;
  }
  return { valid, raw };
}

async function contractProbes(client: pg.Client): Promise<Record<string, number>> {
  const r = await client.query(
    `
    WITH norm AS (
      SELECT d.id AS detail_id,
        lower(btrim(split_part(trim(both ' []"' from COALESCE(s.tracking_number,'')), ',', 1))) AS trk
      FROM public.amazon_removals d
      JOIN public.amazon_removal_shipments s ON s.organization_id = d.organization_id
       AND s.store_id IS NOT DISTINCT FROM d.store_id AND s.order_id IS NOT DISTINCT FROM d.order_id
       AND s.order_type IS NOT DISTINCT FROM d.order_type AND s.order_date IS NOT DISTINCT FROM d.order_date
       AND s.sku IS NOT DISTINCT FROM d.sku AND s.fnsku IS NOT DISTINCT FROM d.fnsku
       AND s.disposition IS NOT DISTINCT FROM d.disposition
      WHERE d.organization_id = $1::uuid AND d.store_id = $2::uuid
        AND s.tracking_number IS NOT NULL AND btrim(s.tracking_number) <> ''
    )
    SELECT
      (SELECT COUNT(*) FROM public.expected_packages
       WHERE organization_id=$1::uuid AND store_id=$2::uuid AND build_source='detail_shipment')::int AS ep_detail_shipment,
      (SELECT COUNT(*) FROM public.expected_packages
       WHERE organization_id=$1::uuid AND store_id=$2::uuid AND build_source='detail_remainder')::int AS ep_detail_remainder,
      (SELECT COUNT(*) FROM (SELECT detail_id, trk FROM norm GROUP BY 1,2) x)::int AS target_tracking_groups,
      (SELECT COUNT(*) FROM public.amazon_removal_shipments
       WHERE organization_id=$1::uuid AND store_id=$2::uuid
         AND tracking_number IS NOT NULL AND position(',' IN tracking_number) > 0)::int AS arms_tracking_dirty,
      (SELECT COUNT(*) FROM public.expected_packages
       WHERE organization_id=$1::uuid AND store_id=$2::uuid
         AND build_source IN ('detail_shipment','detail_remainder')
         AND tracking_number IS NOT NULL AND position(',' IN tracking_number) > 0)::int AS ep_tracking_dirty,
      (SELECT COUNT(*) FROM (
        SELECT d.id FROM public.amazon_removals d
        LEFT JOIN public.expected_packages ep ON ep.source_detail_row_id = d.id
         AND ep.organization_id = d.organization_id
         AND ep.store_id IS NOT DISTINCT FROM d.store_id
         AND ep.build_source IN ('detail_shipment','detail_remainder')
        WHERE d.organization_id=$1::uuid AND d.store_id=$2::uuid
          AND d.order_id IS NOT NULL
        GROUP BY d.id, d.shipped_quantity
        HAVING COALESCE(d.shipped_quantity, 0)
          IS DISTINCT FROM COALESCE(SUM(COALESCE(ep.expected_scan_quantity, 0)), 0)
      ) m)::int AS details_qty_mismatch,
      (SELECT COUNT(*) FROM public.expected_packages ep WHERE ep.build_source='detail_remainder'
       AND ep.organization_id=$1::uuid AND ep.store_id=$2::uuid
       AND EXISTS (SELECT 1 FROM public.expected_packages ep2
         WHERE ep2.source_detail_row_id = ep.source_detail_row_id AND ep2.build_source='detail_remainder' AND ep2.id <> ep.id)
      )::int AS duplicate_remainder
    `,
    [ORG_ID, STORE_ID],
  );
  const row = r.rows[0] as Record<string, number>;
  row.ep_gap_vs_tracking_groups =
    row.target_tracking_groups - row.ep_detail_shipment;
  return row;
}

async function cohortTenSameTracking(client: pg.Client): Promise<Record<string, unknown> | null> {
  const r = await client.query(
    `
    WITH ship AS (
      SELECT d.id AS detail_id,
        d.shipped_quantity::int AS detail_qty,
        s.id AS shipment_id,
        n.operational AS trk
      FROM public.amazon_removals d
      JOIN public.amazon_removal_shipments s ON s.organization_id = d.organization_id
       AND s.store_id IS NOT DISTINCT FROM d.store_id AND s.order_id IS NOT DISTINCT FROM d.order_id
       AND s.order_type IS NOT DISTINCT FROM d.order_type AND s.order_date IS NOT DISTINCT FROM d.order_date
       AND s.sku IS NOT DISTINCT FROM d.sku AND s.fnsku IS NOT DISTINCT FROM d.fnsku
       AND s.disposition IS NOT DISTINCT FROM d.disposition
      JOIN LATERAL public.normalize_removal_tracking_operational(s.tracking_number) n ON TRUE
      WHERE d.organization_id = $1::uuid AND d.store_id = $2::uuid
        AND d.shipped_quantity = 10
        AND COALESCE(s.shipped_quantity, 0) = 1
    ),
    cohort AS (
      SELECT detail_id, detail_qty, COUNT(*)::int AS ship_lines, COUNT(DISTINCT trk)::int AS distinct_trk
      FROM ship
      WHERE trk IS NOT NULL AND btrim(trk) <> ''
      GROUP BY detail_id, detail_qty
      HAVING COUNT(*) = 10 AND COUNT(DISTINCT trk) = 1
      LIMIT 1
    )
    SELECT c.detail_id::text, c.detail_qty, c.ship_lines, c.distinct_trk,
      (SELECT COUNT(*)::int FROM public.expected_packages ep
       WHERE ep.source_detail_row_id = c.detail_id AND ep.build_source = 'detail_shipment') AS ep_ship_rows,
      (SELECT COALESCE(SUM(ep.expected_scan_quantity), 0)::int FROM public.expected_packages ep
       WHERE ep.source_detail_row_id = c.detail_id AND ep.build_source = 'detail_shipment') AS ep_ship_qty_sum,
      (SELECT ep.expected_scan_quantity::int FROM public.expected_packages ep
       WHERE ep.source_detail_row_id = c.detail_id AND ep.build_source = 'detail_remainder' LIMIT 1) AS ep_remainder_qty
    FROM cohort c
    `,
    [ORG_ID, STORE_ID],
  );
  return (r.rows[0] as Record<string, unknown>) ?? null;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const skipMigration = process.argv.includes("--skip-migration");
  const functionOnlyMigration = process.argv.includes("--function-only");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const allocApproval = readApproval(APPROVAL_PATH, [
    "APPROVED_TO_RUN_STAGING",
    "APPROVED_REMOVAL_EXPECTED_ALLOCATION_FIX",
  ]);
  const trackApproval = readApproval(TRACKING_APPROVAL_PATH, [
    "APPROVED_TO_RUN_STAGING",
    "APPROVED_REMOVAL_TRACKING_NORMALIZATION_FIX",
  ]);

  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);
  if (!allocApproval.valid) blockers.push("Allocation approval flags not both true");
  if (!trackApproval.valid) blockers.push("Tracking normalization approval flags not both true (precondition)");

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset");
  else {
    if (!supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
      blockers.push(`DB URL must target staging ${STAGING_REF}`);
    }
    if (dbUrl.includes(ORIGINAL_REF)) blockers.push("DB URL targets original project");
  }

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof",
      "",
      "## Allocation",
      "| Flag | Value |",
      "|------|-------|",
      ...Object.entries(allocApproval.raw).map(([k, v]) => `| ${k} | ${v} |`),
      `| valid | **${allocApproval.valid}** |`,
      "",
      "## Tracking (precondition)",
      ...Object.entries(trackApproval.raw).map(([k, v]) => `| ${k} | ${v} |`),
      `| valid | **${trackApproval.valid}** |`,
      "",
      "No Amazon API. No products/PIM writes.",
    ].join("\n") + "\n",
  );

  if (!apply || blockers.length) {
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      blockers.length
        ? blockers.map((b) => `- ${b}`).join("\n") + "\n"
        : "- Dry-run only; pass `--apply` to execute.\n",
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
  await client.query("SET statement_timeout = '600s'");

  if (!skipMigration) {
    const fullSql = fs.readFileSync(path.join(process.cwd(), MIGRATION_PATH), "utf8");
    const sql = functionOnlyMigration
      ? (fullSql.match(
          /CREATE OR REPLACE FUNCTION public\.rebuild_expected_packages_from_removals[\s\S]*?\$function\$;[\s\S]*?GRANT EXECUTE ON FUNCTION public\.rebuild_expected_packages_from_removals\(uuid, uuid\) TO service_role;/,
        )?.[0] ?? fullSql)
      : fullSql;
    await client.query(sql);
    fs.writeFileSync(
      path.join(outDir, "migration-summary.md"),
      [
        "# Migration applied",
        "",
        `- File: \`${MIGRATION_PATH}\``,
        "- `normalize_removal_tracking_operational`",
        "- Columns: `allocation_group_key`, `source_shipment_row_ids`",
        "- Indexes: `uq_expected_packages_derived_shipment_group`, `uq_expected_packages_derived_remainder`",
        "- Replaced `rebuild_expected_packages_from_removals` with grouped allocation",
      ].join("\n") + "\n",
    );
  }

  const beforeProbes = await contractProbes(client);

  const preimageRes = await client.query(
    `
    SELECT row_to_json(t) AS row
    FROM (
      SELECT id, organization_id, store_id, build_source, source_detail_row_id, source_shipment_row_id,
        allocation_group_key, tracking_number, carrier, shipment_date,
        expected_scan_quantity, actual_scanned_count, id_slip_contents
      FROM public.expected_packages
      WHERE organization_id = $1::uuid AND store_id = $2::uuid
        AND build_source IN ('detail_shipment', 'detail_remainder')
    ) t
    `,
    [ORG_ID, STORE_ID],
  );
  const preimageRows = (preimageRes.rows as Array<{ row: Record<string, unknown> }>).map(
    (r) => r.row,
  );
  fs.writeFileSync(
    path.join(outDir, "preimage-expected-packages.json"),
    JSON.stringify(
      {
        run_id: runId,
        organization_id: ORG_ID,
        store_id: STORE_ID,
        captured_at: new Date().toISOString(),
        row_count: preimageRows.length,
        rows: preimageRows,
      },
      null,
      2,
    ),
  );

  // Merge scan/slip by target allocation_group_key before rebuild collapses rows
  const mergeRes = await client.query(
    `
    WITH old_ep AS (
      SELECT ep.id, ep.build_source, ep.source_detail_row_id,
        ep.actual_scanned_count, ep.id_slip_contents, ep.carrier, ep.shipment_date, ep.tracking_number,
        CASE WHEN ep.build_source = 'detail_remainder' THEN NULL
        ELSE concat_ws('|',
          coalesce((SELECT n.operational FROM public.normalize_removal_tracking_operational(ep.tracking_number) n),
            '__NO_TRACKING__'),
          coalesce(lower(btrim(ep.carrier)), ''),
          coalesce(ep.shipment_date::text, '')
        ) END AS merge_key
      FROM public.expected_packages ep
      WHERE ep.organization_id = $1::uuid AND ep.store_id = $2::uuid
        AND ep.build_source IN ('detail_shipment', 'detail_remainder')
    ),
    merged AS (
      SELECT source_detail_row_id, merge_key, build_source,
        sum(coalesce(actual_scanned_count, 0))::int AS scan_sum,
        (array_agg(id_slip_contents ORDER BY id_slip_contents NULLS LAST)
          FILTER (WHERE id_slip_contents IS NOT NULL AND btrim(id_slip_contents) <> ''))[1] AS slip_pick
      FROM old_ep
      GROUP BY source_detail_row_id, merge_key, build_source
    )
    SELECT * FROM merged WHERE scan_sum > 0 OR slip_pick IS NOT NULL
    `,
    [ORG_ID, STORE_ID],
  );
  const mergeRows = mergeRes.rows as Array<{
    source_detail_row_id: string;
    merge_key: string | null;
    build_source: string;
    scan_sum: number;
    slip_pick: string | null;
  }>;

  await client.query("BEGIN");
  try {
    const rebuildRes = await client.query(
      `SELECT * FROM public.rebuild_expected_packages_from_removals($1::uuid, $2::uuid)`,
      [ORG_ID, STORE_ID],
    );
    const rebuild = rebuildRes.rows[0] as RebuildResult;

    let preservedScans = 0;
    let preservedSlips = 0;
    for (const m of mergeRows) {
      if (m.build_source === "detail_shipment" && m.merge_key) {
        const up = await client.query(
          `
          UPDATE public.expected_packages ep
          SET actual_scanned_count = GREATEST(coalesce(ep.actual_scanned_count,0), $4),
              id_slip_contents = COALESCE(ep.id_slip_contents, $5),
              updated_at = now()
          WHERE ep.organization_id = $1::uuid AND ep.store_id = $2::uuid
            AND ep.build_source = 'detail_shipment'
            AND ep.source_detail_row_id = $3::uuid
            AND ep.allocation_group_key IS NOT DISTINCT FROM $6
          RETURNING ep.id
          `,
          [ORG_ID, STORE_ID, m.source_detail_row_id, m.scan_sum, m.slip_pick, m.merge_key],
        );
        if (up.rowCount && m.scan_sum > 0) preservedScans += up.rowCount;
        if (up.rowCount && m.slip_pick) preservedSlips += up.rowCount;
      } else if (m.build_source === "detail_remainder") {
        const up = await client.query(
          `
          UPDATE public.expected_packages ep
          SET actual_scanned_count = GREATEST(coalesce(ep.actual_scanned_count,0), $4),
              id_slip_contents = COALESCE(ep.id_slip_contents, $5),
              updated_at = now()
          WHERE ep.organization_id = $1::uuid AND ep.store_id = $2::uuid
            AND ep.build_source = 'detail_remainder'
            AND ep.source_detail_row_id = $3::uuid
          RETURNING ep.id
          `,
          [ORG_ID, STORE_ID, m.source_detail_row_id, m.scan_sum, m.slip_pick],
        );
        if (up.rowCount && m.scan_sum > 0) preservedScans += up.rowCount;
        if (up.rowCount && m.slip_pick) preservedSlips += up.rowCount;
      }
    }

    await client.query("COMMIT");

    const afterProbes = await contractProbes(client);
    const cohort = await cohortTenSameTracking(client);

    fs.writeFileSync(
      path.join(outDir, "scan-slip-preservation-report.md"),
      [
        "# Scan / slip preservation",
        "",
        `- Merge groups from preimage: **${mergeRows.length}**`,
        `- Rows updated (scan): **${preservedScans}**`,
        `- Rows updated (slip): **${preservedSlips}**`,
        "",
        "Strategy: sum `actual_scanned_count` by `(source_detail_row_id, allocation_group_key)`; ",
        "coalesce `id_slip_contents` from collapsed rows onto survivor grouped EP rows.",
      ].join("\n") + "\n",
    );

    fs.writeFileSync(
      path.join(outDir, "rebuild-result.md"),
      [
        "# Rebuild result",
        "",
        "| Metric | Value |",
        "|--------|------:|",
        `| detail_lines_in_scope | ${rebuild.detail_lines_in_scope} |`,
        `| matched_rows_upserted | ${rebuild.matched_rows_upserted} |`,
        `| remainder_rows_upserted | ${rebuild.remainder_rows_upserted} |`,
        `| overflow_lines | ${rebuild.overflow_lines} |`,
        `| obsolete_rows_deleted | ${rebuild.obsolete_rows_deleted} |`,
        "",
        "## Before probes",
        "```json",
        JSON.stringify(beforeProbes, null, 2),
        "```",
      ].join("\n") + "\n",
    );

    fs.writeFileSync(
      path.join(outDir, "contract-probes-after.md"),
      [
        "# Contract probes (after)",
        "",
        "```json",
        JSON.stringify({ after: afterProbes, cohort_sample: cohort }, null, 2),
        "```",
        "",
        "## Success gates",
        "",
        `| Gate | Result |`,
        `|------|--------|`,
        `| details_qty_mismatch = 0 | ${afterProbes.details_qty_mismatch === 0 ? "PASS" : "FAIL"} (${afterProbes.details_qty_mismatch}) |`,
        `| ep_tracking_dirty = 0 | ${afterProbes.ep_tracking_dirty === 0 ? "PASS" : "FAIL"} |`,
        `| arms_tracking_dirty = 0 | ${afterProbes.arms_tracking_dirty === 0 ? "PASS" : "FAIL"} |`,
        `| duplicate_remainder = 0 | ${afterProbes.duplicate_remainder === 0 ? "PASS" : "FAIL"} |`,
        `| ep_detail_shipment ≈ target (${afterProbes.target_tracking_groups}) | ${Math.abs(afterProbes.ep_detail_shipment - afterProbes.target_tracking_groups) <= 50 ? "PASS" : "WARN"} (${afterProbes.ep_detail_shipment}) |`,
      ].join("\n") + "\n",
    );

    const rollbackLines = [
      "-- Rollback: restore from preimage-expected-packages.json (manual)",
      "-- Or re-apply prior migration 20260632 and restore rows from JSON",
      `DELETE FROM public.expected_packages WHERE organization_id = '${ORG_ID}'::uuid AND store_id = '${STORE_ID}'::uuid AND build_source IN ('detail_shipment','detail_remainder');`,
      "-- INSERT rows from preimage JSON with appropriate ON CONFLICT",
    ];
    fs.writeFileSync(path.join(outDir, "rollback.sql"), rollbackLines.join("\n") + "\n");

    const execBlockers: string[] = [];
    if (afterProbes.details_qty_mismatch > 0) {
      execBlockers.push(`details_qty_mismatch=${afterProbes.details_qty_mismatch}`);
    }
    if (afterProbes.ep_tracking_dirty > 0) {
      execBlockers.push(`ep_tracking_dirty=${afterProbes.ep_tracking_dirty}`);
    }
    if (afterProbes.arms_tracking_dirty > 0) {
      execBlockers.push(`arms_tracking_dirty=${afterProbes.arms_tracking_dirty}`);
    }

    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      execBlockers.length
        ? execBlockers.map((b) => `- ${b}`).join("\n") + "\n"
        : "- None\n",
    );

    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify(
        {
          run_id: runId,
          ok: execBlockers.length === 0,
          before: beforeProbes,
          after: afterProbes,
          rebuild,
          cohort,
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
          ep_detail_shipment: afterProbes.ep_detail_shipment,
          ep_detail_remainder: afterProbes.ep_detail_remainder,
          mismatch: afterProbes.details_qty_mismatch,
          dirty: afterProbes.ep_tracking_dirty,
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
