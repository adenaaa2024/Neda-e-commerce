/**
 * REMOVAL-REBUILD-INVESTIGATE — allocation invariant failures (read-only)
 *
 *   npx tsx scripts/removal-rebuild-investigate-allocation-failures.ts
 *   npx tsx scripts/removal-rebuild-investigate-allocation-failures.ts --verify-run-id=20260528T140000Z
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess, supabaseUrlMatchesStagingRef } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const SAM_ORG = "00000000-0000-0000-0000-000000000001";
const SAM_STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/removal-rebuild-investigate-allocation-failures";
const VERIFY_BASE = ".cursor/audit-reports/removal-rebuild-verify-and-resolver-dryrun";
const DEFAULT_VERIFY_RUN = "20260528T140000Z";

type MismatchRow = {
  detail_id: string;
  order_id: string | null;
  sku: string | null;
  fnsku: string | null;
  detail_total: number;
  shipment_total: number;
  shipment_count: number;
  is_overflow: boolean;
  sim_sum: number | null;
  live_sum: number | null;
  delta: number | null;
  live_shipment_rows: number;
  live_remainder_rows: number;
  live_duplicate_remainder: number;
  fix_category: string;
  root_cause: string;
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

function verifyRunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--verify-run-id="));
  return a ? a.split("=")[1]!.trim() : DEFAULT_VERIFY_RUN;
}

function classify(row: MismatchRow): { fix_category: string; root_cause: string } {
  const sim = row.sim_sum ?? 0;
  const live = row.live_sum ?? 0;
  const delta = live - sim;

  if (row.sim_sum == null) {
    return {
      fix_category: "stale_rows",
      root_cause: "Live EP rows exist for detail_id with no simulation emission (orphan derived EP).",
    };
  }
  if (row.live_sum == null) {
    return {
      fix_category: "non_overflow_actual_bug",
      root_cause: "Simulation expects EP rows but live derived EP missing for detail line.",
    };
  }

  if (row.live_duplicate_remainder > 1) {
    return {
      fix_category: "duplicate_key",
      root_cause: `Multiple detail_remainder rows (${row.live_remainder_rows} total, ${row.live_duplicate_remainder} with null shipment id) inflate live_sum by ${delta}.`,
    };
  }

  if (row.is_overflow) {
    if (live === row.shipment_total && sim === row.shipment_total + Math.max(row.detail_total - row.shipment_total, 0)) {
      return {
        fix_category: "overflow_expected_mismatch",
        root_cause:
          "Verify simulation emits remainder qty even when overflow; rebuild omits remainder (sum=shipment_total only). Invariant query bug, not live data bug.",
      };
    }
    if (sim === row.shipment_total && live === row.shipment_total) {
      return {
        fix_category: "overflow_expected_mismatch",
        root_cause: "Overflow line — sim and live both equal shipment_total; mismatch from duplicate/stale EP rows.",
      };
    }
    return {
      fix_category: "overflow_expected_mismatch",
      root_cause: `Overflow detail: sim=${sim} live=${live} shipment_total=${row.shipment_total} detail_total=${row.detail_total}.`,
    };
  }

  if (Math.abs(delta) === 0) {
    return { fix_category: "rounding_precision", root_cause: "Negligible — reclassified." };
  }

  if (row.live_remainder_rows > 1) {
    return {
      fix_category: "remainder_allocation",
      root_cause: "Multiple remainder EP rows for one detail without unique-index collision (distinct shipment_row_id nulls pre-index?).",
    };
  }

  if (live > sim && row.live_remainder_rows >= 1 && row.shipment_count > 0) {
    return {
      fix_category: "stale_rows",
      root_cause:
        "Stale remainder row(s) not deleted by obsolete cleanup — pair key mismatch vs rebuild target.",
    };
  }

  return {
    fix_category: "non_overflow_actual_bug",
    root_cause: `Non-overflow qty mismatch sim=${sim} live=${live} detail=${row.detail_total} shipment=${row.shipment_total}.`,
  };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const verifyRunId = verifyRunIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    throw new Error(`STAGING_DIRECT_POSTGRES_URL must target ${STAGING_REF}`);
  }

  const verifyDir = path.join(process.cwd(), VERIFY_BASE, verifyRunId);
  const verifyManifestPath = path.join(verifyDir, "manifest.json");
  const verifyLoaded = fs.existsSync(verifyManifestPath);
  const verifyManifest = verifyLoaded
    ? (JSON.parse(fs.readFileSync(verifyManifestPath, "utf8")) as Record<string, unknown>)
    : null;

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '180s'");

  const shipCols = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='amazon_removal_shipments'`,
  );
  const shipmentHasDisposition = (shipCols.rows as Array<{ column_name: string }>).some(
    (x) => x.column_name === "disposition",
  );
  const shipDispositionSel = shipmentHasDisposition
    ? "nullif(btrim(s.disposition), '') AS disposition"
    : "NULL::text AS disposition";
  const dispositionJoin = shipmentHasDisposition
    ? "AND s.disposition IS NOT DISTINCT FROM d.disposition"
    : "";

  const mismatchRes = await client.query(
    `
    WITH detail AS (
      SELECT d.id AS detail_id, d.order_id,
        nullif(btrim(d.sku),'') AS sku, nullif(btrim(d.fnsku),'') AS fnsku,
        COALESCE(d.shipped_quantity, 0) AS detail_shipped_qty,
        d.organization_id, d.store_id, d.order_type, d.order_date,
        nullif(btrim(d.disposition),'') AS disposition
      FROM public.amazon_removals d
      WHERE d.organization_id = $1::uuid AND d.store_id = $2::uuid AND d.order_id IS NOT NULL
    ),
    shipment AS (
      SELECT s.id AS shipment_id, s.organization_id, s.store_id, s.order_id, s.order_type, s.order_date,
        nullif(btrim(s.sku),'') AS sku, nullif(btrim(s.fnsku),'') AS fnsku, ${shipDispositionSel},
        COALESCE(s.shipped_quantity, 0) AS shipment_shipped_qty
      FROM public.amazon_removal_shipments s
      WHERE s.organization_id = $1::uuid AND s.store_id = $2::uuid
    ),
    pair AS (
      SELECT d.detail_id, d.order_id, d.sku, d.fnsku, d.detail_shipped_qty,
        s.shipment_id, s.shipment_shipped_qty
      FROM detail d
      LEFT JOIN shipment s
        ON s.organization_id = d.organization_id AND s.store_id IS NOT DISTINCT FROM d.store_id
       AND s.order_id IS NOT DISTINCT FROM d.order_id AND s.order_type IS NOT DISTINCT FROM d.order_type
       AND s.order_date IS NOT DISTINCT FROM d.order_date AND s.sku IS NOT DISTINCT FROM d.sku
       AND s.fnsku IS NOT DISTINCT FROM d.fnsku ${dispositionJoin}
    ),
    agg AS (
      SELECT detail_id, max(order_id) AS order_id, max(sku) AS sku, max(fnsku) AS fnsku,
        max(detail_shipped_qty) AS detail_total,
        sum(COALESCE(shipment_shipped_qty, 0)) FILTER (WHERE shipment_id IS NOT NULL) AS shipment_total,
        count(*) FILTER (WHERE shipment_id IS NOT NULL) AS shipment_count
      FROM pair GROUP BY detail_id
    ),
    matched_emitted AS (
      SELECT p.detail_id, p.shipment_shipped_qty AS qty
      FROM pair p JOIN agg a USING (detail_id) WHERE p.shipment_id IS NOT NULL
    ),
    remainder_emitted AS (
      SELECT DISTINCT ON (p.detail_id) p.detail_id,
        GREATEST(a.detail_total - COALESCE(a.shipment_total, 0), 0)::int AS qty
      FROM pair p JOIN agg a USING (detail_id)
      WHERE COALESCE(a.shipment_count, 0) = 0 OR a.detail_total > COALESCE(a.shipment_total, 0)
      ORDER BY p.detail_id
    ),
    emitted AS (
      SELECT detail_id, qty FROM matched_emitted
      UNION ALL SELECT detail_id, qty FROM remainder_emitted
    ),
    sim AS (SELECT detail_id, sum(qty)::int AS sim_sum FROM emitted GROUP BY 1),
    live AS (
      SELECT source_detail_row_id AS detail_id,
        sum(expected_scan_quantity)::int AS live_sum,
        count(*) FILTER (WHERE build_source = 'detail_shipment')::int AS live_shipment_rows,
        count(*) FILTER (WHERE build_source = 'detail_remainder')::int AS live_remainder_rows
      FROM public.expected_packages
      WHERE organization_id = $1::uuid AND store_id = $2::uuid
        AND build_source IN ('detail_shipment', 'detail_remainder')
      GROUP BY 1
    ),
    live_dup AS (
      SELECT source_detail_row_id AS detail_id,
        count(*) FILTER (
          WHERE build_source = 'detail_remainder' AND source_shipment_row_id IS NULL
        )::int AS live_duplicate_remainder
      FROM public.expected_packages
      WHERE organization_id = $1::uuid AND store_id = $2::uuid
        AND build_source = 'detail_remainder'
      GROUP BY 1
      HAVING count(*) > 1
    ),
    mism AS (
      SELECT
        COALESCE(sim.detail_id, live.detail_id) AS detail_id,
        a.order_id,
        a.sku,
        a.fnsku,
        a.detail_total,
        COALESCE(a.shipment_total, 0) AS shipment_total,
        COALESCE(a.shipment_count, 0) AS shipment_count,
        (COALESCE(a.shipment_total, 0) > a.detail_total) AS is_overflow,
        sim.sim_sum,
        live.live_sum,
        (live.live_sum - sim.sim_sum) AS delta,
        COALESCE(live.live_shipment_rows, 0) AS live_shipment_rows,
        COALESCE(live.live_remainder_rows, 0) AS live_remainder_rows,
        COALESCE(ld.live_duplicate_remainder, live.live_remainder_rows) AS live_duplicate_remainder
      FROM sim FULL OUTER JOIN live USING (detail_id)
      JOIN agg a ON a.detail_id = COALESCE(sim.detail_id, live.detail_id)
      LEFT JOIN live_dup ld ON ld.detail_id = COALESCE(sim.detail_id, live.detail_id)
      WHERE COALESCE(sim.sim_sum, -1) <> COALESCE(live.live_sum, -2)
    )
    SELECT * FROM mism ORDER BY is_overflow ASC, abs(delta) DESC, detail_id
    `,
    [SAM_ORG, SAM_STORE],
  );

  const dupRemainderAudit = await client.query(
    `
    SELECT source_detail_row_id::text AS detail_id, count(*)::int AS remainder_count,
      array_agg(id::text ORDER BY rebuild_run_at NULLS LAST, updated_at) AS ep_ids,
      array_agg(expected_scan_quantity::int ORDER BY rebuild_run_at NULLS LAST) AS qtys
    FROM public.expected_packages
    WHERE organization_id = $1::uuid AND store_id = $2::uuid
      AND build_source = 'detail_remainder'
    GROUP BY source_detail_row_id
    HAVING count(*) > 1
    ORDER BY count(*) DESC
    LIMIT 100
    `,
    [SAM_ORG, SAM_STORE],
  );

  const simOverflowCorrect = await client.query(
    `
    WITH detail AS (
      SELECT d.id AS detail_id, COALESCE(d.shipped_quantity, 0) AS detail_total
      FROM public.amazon_removals d
      WHERE d.organization_id = $1::uuid AND d.store_id = $2::uuid AND d.order_id IS NOT NULL
    ),
    shipment AS (
      SELECT s.id AS shipment_id, d.id AS detail_id, COALESCE(s.shipped_quantity, 0) AS qty
      FROM public.amazon_removal_shipments s
      JOIN public.amazon_removals d
        ON d.organization_id = s.organization_id AND d.store_id IS NOT DISTINCT FROM s.store_id
       AND d.order_id IS NOT DISTINCT FROM s.order_id AND d.order_type IS NOT DISTINCT FROM s.order_type
       AND d.order_date IS NOT DISTINCT FROM s.order_date
       AND nullif(btrim(d.sku),'') IS NOT DISTINCT FROM nullif(btrim(s.sku),'')
       AND nullif(btrim(d.fnsku),'') IS NOT DISTINCT FROM nullif(btrim(s.fnsku),'')
       ${shipmentHasDisposition ? "AND nullif(btrim(d.disposition),'') IS NOT DISTINCT FROM nullif(btrim(s.disposition),'')" : ""}
      WHERE s.organization_id = $1::uuid AND s.store_id = $2::uuid
    ),
    agg AS (
      SELECT d.detail_id, d.detail_total,
        coalesce(sum(s.qty), 0) AS shipment_total
      FROM detail d
      LEFT JOIN shipment s USING (detail_id)
      GROUP BY d.detail_id, d.detail_total
    )
    SELECT count(*)::int AS overflow_details
    FROM agg WHERE shipment_total > detail_total
    `,
    [SAM_ORG, SAM_STORE],
  );

  await client.end();

  const rows = (mismatchRes.rows as MismatchRow[]).map((r) => {
    const classified = classify({
      ...r,
      detail_total: Number(r.detail_total),
      shipment_total: Number(r.shipment_total),
      shipment_count: Number(r.shipment_count),
      is_overflow: Boolean(r.is_overflow),
      sim_sum: r.sim_sum == null ? null : Number(r.sim_sum),
      live_sum: r.live_sum == null ? null : Number(r.live_sum),
      delta: r.delta == null ? null : Number(r.delta),
      live_shipment_rows: Number(r.live_shipment_rows),
      live_remainder_rows: Number(r.live_remainder_rows),
      live_duplicate_remainder: Number(r.live_duplicate_remainder),
      fix_category: "",
      root_cause: "",
    });
    return { ...r, ...classified };
  });

  const byCategory = rows.reduce(
    (acc, r) => {
      acc[r.fix_category] = (acc[r.fix_category] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const nonOverflowBugs = rows.filter(
    (r) => r.fix_category === "non_overflow_actual_bug" && !r.is_overflow,
  );

  const fixType =
    byCategory.duplicate_key || byCategory.stale_rows
      ? "db_cleanup_then_rebuild_obsolete_fix"
      : byCategory.overflow_expected_mismatch === rows.length
        ? "verify_script_fix_only"
        : byCategory.non_overflow_actual_bug
          ? "rebuild_function_or_data_fix"
          : "mixed";

  const nextPrompt =
    fixType === "db_cleanup_then_rebuild_obsolete_fix"
      ? "REMOVAL-REBUILD-DUPLICATE-REMAINDER-CLEANUP-EXECUTE — delete duplicate detail_remainder EP rows then rerun rebuild (staging, approval-gated)"
      : fixType === "verify_script_fix_only"
        ? "REMOVAL-REBUILD-VERIFY-SCRIPT-FIX — align overflow simulation with rebuild contract; re-run verify"
        : "REMOVAL-REBUILD-ALLOCATION-PATCH-EXECUTE — apply migration patch to rebuild obsolete cleanup + verify script";

  fs.writeFileSync(path.join(outDir, "mismatches-all.json"), JSON.stringify(rows, null, 2));
  fs.writeFileSync(
    path.join(outDir, "mismatches-by-category.json"),
    JSON.stringify(byCategory, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "duplicate-remainder-audit.json"),
    JSON.stringify(dupRemainderAudit.rows, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "non-overflow-root-causes.md"),
    [
      "# Non-overflow mismatch root causes",
      "",
      `Count: **${nonOverflowBugs.length}**`,
      "",
      ...nonOverflowBugs.map(
        (r, i) =>
          `## ${i + 1}. \`${r.detail_id}\` (order \`${r.order_id}\`, sku \`${r.sku}\`)`,
      ),
      ...nonOverflowBugs.flatMap((r) => [
        "",
        `- detail_total: ${r.detail_total}`,
        `- shipment_total: ${r.shipment_total}`,
        `- sim_sum: ${r.sim_sum}`,
        `- live_sum: ${r.live_sum}`,
        `- live remainder rows: ${r.live_remainder_rows}`,
        `- **root_cause:** ${r.root_cause}`,
        "",
      ]),
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "patch-plan.md"),
    [
      "# Patch plan",
      "",
      "## Findings summary",
      "",
      `- Total mismatches: **${rows.length}**`,
      `- Non-overflow bugs: **${nonOverflowBugs.length}**`,
      `- Duplicate remainder detail lines: **${dupRemainderAudit.rowCount}**`,
      `- Overflow detail lines in domain: **${(simOverflowCorrect.rows[0] as { overflow_details: number }).overflow_details}**`,
      "",
      "## Category split",
      "",
      ...Object.entries(byCategory).map(([k, v]) => `- \`${k}\`: ${v}`),
      "",
      "## Simulation vs rebuild logic gap",
      "",
      "| Case | Verify simulation | `rebuild_expected_packages_from_removals` |",
      "|------|-------------------|-------------------------------------------|",
      "| Non-overflow | sum(matched shipment qty) + remainder `GREATEST(D−S,0)` | Same |",
      "| **Overflow** (`S > D`) | Still emits remainder when `S>D` is false in WHERE — **should omit** | Omits remainder; sum = **S only** |",
      "| Obsolete cleanup | N/A | Deletes EP not in `_rebuild_target` matching `(detail_id, shipment_id, build_source)` |",
      "",
      "## Recommended fixes (no DB write in this pass)",
      "",
      "### 1. Verify script (`removal-rebuild-verify-and-resolver-dryrun.ts`)",
      "",
      "Change `remainder_emitted` WHERE to match rebuild SQL exactly:",
      "",
      "```sql",
      "WHERE COALESCE(a.shipment_count, 0) = 0",
      "   OR (a.detail_total > COALESCE(a.shipment_total, 0)",
      "       AND COALESCE(a.shipment_total, 0) <= a.detail_total)  -- exclude overflow",
      "```",
      "",
      "Or simply: `WHERE COALESCE(a.shipment_count,0)=0 OR a.detail_total > COALESCE(a.shipment_total,0)` — already excludes overflow remainder; overflow mismatches then indicate **duplicate/stale EP rows**, not logic gap.",
      "",
      "### 2. Duplicate remainder rows (if audit > 0)",
      "",
      "Root cause: idempotent rebuild upserts one `(detail_id, NULL shipment_id)` remainder per detail, but **obsolete delete** may miss duplicates when:",
      "",
      "- Multiple `detail_remainder` rows share `source_detail_row_id` but differ in `source_shipment_row_id` (non-null stale keys)",
      "- Pre-index legacy rows before `NULLS NOT DISTINCT` partial unique index",
      "",
      "**Cleanup SQL (staging, approval-gated execute):**",
      "",
      "```sql",
      "-- Keep newest rebuild_run_at remainder per detail; delete older duplicates",
      "WITH ranked AS (",
      "  SELECT id, source_detail_row_id,",
      "    row_number() OVER (",
      "      PARTITION BY organization_id, source_detail_row_id",
      "      ORDER BY rebuild_run_at DESC NULLS LAST, updated_at DESC",
      "    ) AS rn",
      "  FROM public.expected_packages",
      "  WHERE organization_id = $ORG AND store_id = $STORE",
      "    AND build_source = 'detail_remainder'",
      ")",
      "DELETE FROM public.expected_packages ep",
      "USING ranked r WHERE ep.id = r.id AND r.rn > 1;",
      "```",
      "",
      "Then rerun `rebuild_expected_packages_from_removals`.",
      "",
      "### 3. Rebuild obsolete cleanup hardening (migration follow-up)",
      "",
      "Extend obsolete delete to remove **extra** remainder rows per `source_detail_row_id` not matching `_rebuild_target` single remainder row (not only full target miss).",
      "",
      "## Verify artifact reference",
      "",
      verifyLoaded
        ? `- Loaded: \`${path.relative(process.cwd(), verifyManifestPath).replace(/\\/g, "/")}\``
        : `- Referenced verify run \`${verifyRunId}\` **not found** — investigation used live staging query.`,
      "",
      verifyManifest
        ? `- Reported ep_mismatch: ${verifyManifest.ep_mismatch_vs_simulation}`
        : "",
      "",
      `**Fix type:** \`${fixType}\``,
      "",
      `**Next prompt:** ${nextPrompt}`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "REMOVAL-REBUILD-INVESTIGATE — ALLOCATION INVARIANT FAILURES",
        run_id: runId,
        verify_run_id: verifyRunId,
        verify_artifact_loaded: verifyLoaded,
        staging_ref: STAGING_REF,
        total_mismatches: rows.length,
        non_overflow_bug_count: nonOverflowBugs.length,
        by_category: byCategory,
        duplicate_remainder_detail_lines: dupRemainderAudit.rowCount,
        fix_type: fixType,
        exact_next_prompt: nextPrompt,
        no_db_writes: true,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        outDir: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
        total_mismatches: rows.length,
        non_overflow_bug_count: nonOverflowBugs.length,
        fix_type: fixType,
        next_prompt: nextPrompt,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
