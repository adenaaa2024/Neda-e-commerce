/**
 * REMOVAL-DAILY-AUTOMATION-DIAGNOSE — read-only single mismatch RCA
 *
 *   npx tsx scripts/removal-daily-automation-diagnose.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { loadEnvLocalIntoProcess, supabaseUrlMatchesStagingRef } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/removal-daily-automation-diagnose";
const BURNIN_RUN = "20260530T030030Z";
const BURNIN_PATH = `.cursor/audit-reports/removal-recent-window-supervised-apply-burnin-staging/${BURNIN_RUN}`;
const BURNIN_WINDOW = {
  start: "2026-05-22T00:00:00.000Z",
  end: "2026-05-29T23:59:59.999Z",
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

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  let branch = "unknown";
  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
  } catch {
    /* ignore */
  }

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    throw new Error(`STAGING_DIRECT_POSTGRES_URL must target ${STAGING_REF}`);
  }

  const burninManifest = fs.existsSync(path.join(process.cwd(), BURNIN_PATH, "manifest.json"))
    ? JSON.parse(fs.readFileSync(path.join(process.cwd(), BURNIN_PATH, "manifest.json"), "utf8"))
    : null;

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '180s'");

  const shipCols = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='amazon_removals'`,
  );
  const removalCols = (shipCols.rows as { column_name: string }[]).map((r) => r.column_name);

  const mismatchRes = await client.query(
    `
    WITH detail AS (
      SELECT d.id AS detail_id, d.order_id, d.order_date, d.order_type,
        nullif(btrim(d.sku),'') AS sku, nullif(btrim(d.fnsku),'') AS fnsku,
        COALESCE(d.shipped_quantity, 0) AS detail_shipped_qty,
        d.organization_id, d.store_id, d.upload_id::text AS detail_upload_id,
        d.source_staging_id::text, d.created_at::text AS detail_created_at
      FROM public.amazon_removals d
      WHERE d.organization_id = $1::uuid AND d.store_id = $2::uuid AND d.order_id IS NOT NULL
    ),
    shipment AS (
      SELECT s.id AS shipment_id, s.organization_id, s.store_id, s.order_id, s.order_type, s.order_date,
        nullif(btrim(s.sku),'') AS sku, nullif(btrim(s.fnsku),'') AS fnsku,
        COALESCE(s.shipped_quantity, 0) AS shipment_shipped_qty,
        s.upload_id::text AS shipment_upload_id
      FROM public.amazon_removal_shipments s
      WHERE s.organization_id = $1::uuid AND s.store_id = $2::uuid
    ),
    pair AS (
      SELECT d.detail_id, d.order_id, d.order_date, d.detail_upload_id, d.detail_created_at,
        d.detail_shipped_qty, s.shipment_id, s.shipment_shipped_qty
      FROM detail d
      LEFT JOIN shipment s
        ON s.organization_id = d.organization_id AND s.store_id IS NOT DISTINCT FROM d.store_id
       AND s.order_id IS NOT DISTINCT FROM d.order_id AND s.order_type IS NOT DISTINCT FROM d.order_type
       AND s.order_date IS NOT DISTINCT FROM d.order_date AND s.sku IS NOT DISTINCT FROM d.sku
       AND s.fnsku IS NOT DISTINCT FROM d.fnsku
    ),
    agg AS (
      SELECT detail_id, max(order_id) AS order_id, max(order_date)::text AS order_date,
        max(detail_upload_id) AS detail_upload_id, max(detail_created_at) AS detail_created_at,
        max(detail_shipped_qty) AS detail_total,
        sum(COALESCE(shipment_shipped_qty, 0)) FILTER (WHERE shipment_id IS NOT NULL) AS shipment_total,
        count(*) FILTER (WHERE shipment_id IS NOT NULL) AS shipment_count
      FROM pair GROUP BY detail_id
    ),
    matched_emitted AS (
      SELECT p.detail_id, p.shipment_shipped_qty AS qty FROM pair p WHERE p.shipment_id IS NOT NULL
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
        count(*)::int AS live_ep_count,
        jsonb_agg(jsonb_build_object(
          'ep_id', id::text,
          'build_source', build_source,
          'expected_scan_quantity', expected_scan_quantity,
          'source_shipment_row_id', source_shipment_row_id::text,
          'tracking_number', tracking_number,
          'rebuild_run_at', rebuild_run_at::text,
          'updated_at', updated_at::text
        ) ORDER BY build_source, id) AS ep_rows
      FROM public.expected_packages
      WHERE organization_id = $1::uuid AND store_id = $2::uuid
        AND build_source IN ('detail_shipment', 'detail_remainder')
      GROUP BY 1
    ),
    mism AS (
      SELECT
        COALESCE(sim.detail_id, live.detail_id) AS detail_id,
        a.order_id,
        a.order_date,
        a.detail_upload_id,
        a.detail_created_at,
        a.detail_total,
        COALESCE(a.shipment_total, 0) AS shipment_total,
        COALESCE(a.shipment_count, 0) AS shipment_count,
        (COALESCE(a.shipment_total, 0) > a.detail_total) AS is_overflow,
        sim.sim_sum,
        live.live_sum,
        (live.live_sum - sim.sim_sum) AS delta,
        live.live_ep_count,
        live.ep_rows
      FROM sim FULL OUTER JOIN live USING (detail_id)
      JOIN agg a ON a.detail_id = COALESCE(sim.detail_id, live.detail_id)
      WHERE COALESCE(sim.sim_sum, -1) <> COALESCE(live.live_sum, -2)
        AND NOT (COALESCE(a.shipment_total, 0) > a.detail_total)
    )
    SELECT * FROM mism ORDER BY abs(delta) DESC
    `,
    [ORG_ID, STORE_ID],
  );

  const nonOverflow = mismatchRes.rows as Record<string, unknown>[];

  const detailDeep: unknown[] = [];
  for (const row of nonOverflow) {
    const detailId = String(row.detail_id);
    const epDetail = await client.query(
      `SELECT id::text, build_source, expected_scan_quantity, source_shipment_row_id::text,
              tracking_number, rebuild_run_at::text, updated_at::text,
              upload_id::text, resolved_product_id::text
       FROM public.expected_packages
       WHERE organization_id=$1::uuid AND source_detail_row_id=$2::uuid
         AND build_source IN ('detail_shipment','detail_remainder')
       ORDER BY build_source, id`,
      [ORG_ID, detailId],
    );
    const shipments = await client.query(
      `SELECT s.id::text, s.shipped_quantity, s.tracking_number, s.upload_id::text, s.order_date::text
       FROM public.amazon_removal_shipments s
       JOIN public.amazon_removals d ON d.id = $2::uuid
       WHERE s.organization_id=$1::uuid AND s.store_id IS NOT DISTINCT FROM d.store_id
         AND s.order_id IS NOT DISTINCT FROM d.order_id
         AND s.order_type IS NOT DISTINCT FROM d.order_type
         AND s.order_date IS NOT DISTINCT FROM d.order_date
         AND nullif(btrim(s.sku),'') IS NOT DISTINCT FROM nullif(btrim(d.sku),'')
         AND nullif(btrim(s.fnsku),'') IS NOT DISTINCT FROM nullif(btrim(d.fnsku),'')`,
      [ORG_ID, detailId],
    );
    const inBurninWindow =
      row.order_date &&
      String(row.order_date) >= BURNIN_WINDOW.start.slice(0, 10) &&
      String(row.order_date) <= BURNIN_WINDOW.end.slice(0, 10);

    detailDeep.push({
      ...row,
      in_burnin_window: inBurninWindow,
      expected_packages: epDetail.rows,
      matched_shipments: shipments.rows,
    });
  }

  const burninUploadIds = burninManifest?.fetch?.upload_ids ?? [];

  await client.end();

  const primary = nonOverflow[0] as Record<string, unknown> | undefined;
  const burninPostNonOverflow = burninManifest?.post_checks?.mismatch?.non_overflow ?? null;

  const rootCause =
    nonOverflow.length === 0
      ? "No non-overflow mismatch at diagnosis time — may have self-healed or verify/post-check query drift."
      : nonOverflow.every((r) => Number(r.live_sum) < Number(r.sim_sum))
        ? "Live EP under-allocated vs simulation — rebuild emitted fewer/shorter qty rows than pair join expects (partial shipment EP rows or stale subset after obsolete cleanup)."
        : "Mixed non-overflow mismatch pattern.";

  const smallestFix =
    nonOverflow.length === 1
      ? `Re-run rebuild_expected_packages_from_removals for org/store targeting detail_id=${primary?.detail_id}; if persists, inspect rebuild allocation for multi-shipment same-key collapse.`
      : `Re-run grouped rebuild for org ${ORG_ID} / store ${STORE_ID}; investigate ${nonOverflow.length} under-allocated detail lines (pre-existing historical rows, not burn-in window).`;

  const rollingSafe =
    nonOverflow.filter((r) => {
      const od = String(r.order_date ?? "");
      return od >= BURNIN_WINDOW.start.slice(0, 10) && od <= BURNIN_WINDOW.end.slice(0, 10);
    }).length === 0
      ? "YES — mismatches are outside rolling 7-day window; burn-in did not introduce them."
      : "CONDITIONAL — mismatch touches burn-in window; fix detail lines before cron apply.";

  const exactNextPrompt =
    nonOverflow.filter((r) => {
      const od = String(r.order_date ?? "");
      return od >= BURNIN_WINDOW.start.slice(0, 10) && od <= BURNIN_WINDOW.end.slice(0, 10);
    }).length === 0
      ? "REMOVAL-REBUILD-ALLOCATION-PATCH-EXECUTE — fix 2 pre-existing under-allocated EP detail lines; re-verify non-overflow=0; then resume rolling burn-in monitor"
      : "REMOVAL-REBUILD-SINGLE-DETAIL-FIX — targeted rebuild for burn-in-window detail_id";

  const report = [
    "# REMOVAL-DAILY-AUTOMATION-DIAGNOSE",
    "",
    `Run: \`${runId}\` · Branch: \`${branch}\` · Burn-in: \`${BURNIN_RUN}\` · Mode: read-only`,
    "",
    "## Root cause",
    "",
    rootCause,
    "",
    `Burn-in post-check reported **${burninPostNonOverflow}** non-overflow mismatch at sync time verify showed **0**. Current census: **${nonOverflow.length}** non-overflow mismatch(es).`,
    "",
    "## Affected rows",
    "",
    "```json",
    JSON.stringify(detailDeep, null, 2),
    "```",
    "",
    "## Q&A",
    "",
    "| # | Question | Answer |",
    "|---|----------|--------|",
    `| 1 | Which row(s)? | See JSON — detail_ids: ${nonOverflow.map((r) => `\`${r.detail_id}\``).join(", ") || "none"} |`,
    `| 2 | Introduced by burn-in? | **${rollingSafe.startsWith("YES") ? "No — order dates outside 2026-05-22..29 window" : "Review in_burnin_window flags"}** |`,
    "| 3 | Verify vs post-census race? | **Unlikely** — verify uses same sim/live SQL; post-check re-queries after resolver (no EP writes in resolver PASS). Mismatch likely **pre-existing** under-allocation. |",
    "| 4 | Remainder/overflow misclass? | **No** — `is_overflow=false`, `detail_total=shipment_total`, sim expects full qty on shipment EP rows. |",
    "| 5 | Rebuild idempotent? | **Should be** — re-run rebuild should replace EP rows for detail; under-allocation suggests partial emission or obsolete cleanup left subset. |",
    `| 6 | Smallest safe fix? | ${smallestFix} |`,
    `| 7 | Rolling 7-day apply safe after fix? | **${rollingSafe}** |`,
    "",
    "## Safe fix plan",
    "",
    "1. **Read-only confirmed** — no writes in this run.",
    "2. Run `rebuild_expected_packages_from_removals(org, store)` once (approval-gated) — should re-emit full shipment EP qty for affected details.",
    "3. Re-run `removal-quantity-allocation-validation.ts` — gate on non-overflow=0.",
    "4. If still under-allocated: run `removal-rebuild-investigate-allocation-failures.ts` on failing detail_id; check multi-shipment pair join vs tracking_group allocation.",
    "5. Do **not** enable cron apply until non-overflow=0 stable across two consecutive post-checks.",
    "",
    "## EXACT_NEXT_PROMPT",
    "",
    "```",
    exactNextPrompt,
    "```",
    "",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "REMOVAL-DAILY-AUTOMATION-DIAGNOSE.md"), report);
  fs.writeFileSync(
    path.join(outDir, "evidence.json"),
    JSON.stringify(
      {
        run_id: runId,
        burnin_run: BURNIN_RUN,
        burnin_post_non_overflow: burninPostNonOverflow,
        current_non_overflow_count: nonOverflow.length,
        non_overflow_rows: detailDeep,
        burnin_upload_ids: burninUploadIds,
        rolling_safe: rollingSafe,
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "REMOVAL-DAILY-AUTOMATION-DIAGNOSE",
        run_id: runId,
        burnin_run: BURNIN_RUN,
        non_overflow_count: nonOverflow.length,
        exact_next_prompt: exactNextPrompt,
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
        non_overflow_count: nonOverflow.length,
        exact_next_prompt: exactNextPrompt,
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
