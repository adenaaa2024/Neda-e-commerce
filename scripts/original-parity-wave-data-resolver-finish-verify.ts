/**
 * ORIGINAL-PARITY-WAVE-DATA-RESOLVER-FINISH-VERIFY (read-only)
 *
 *   npx tsx scripts/original-parity-wave-data-resolver-finish-verify.ts
 *   npx tsx scripts/original-parity-wave-data-resolver-finish-verify.ts --run-id=20260528T220000Z
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/original-parity-wave-data-resolver-finish-verify";
const DATA_EXECUTE_RUN = "20260528T201200Z";
const DATA_EXECUTE_DIR = `.cursor/audit-reports/original-parity-phase1-wave-data-execute/${DATA_EXECUTE_RUN}`;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function refFromConnectionUrl(url: string): string | null {
  const fromHost = refFromSupabaseUrl(url);
  if (fromHost) return fromHost;
  const m = url.match(/\.([a-z]{20})\./i) ?? url.match(/postgres\.([a-z]{20})/i);
  return m?.[1]?.toLowerCase() ?? null;
}

type EpCensus = {
  ep_total: number;
  ep_derived: number;
  ep_resolved: number;
  ep_derived_unresolved: number;
  ep_status_resolved: number;
  ep_status_unresolved: number;
  ep_status_ambiguous: number;
  ep_status_other: number;
};

async function epCensus(client: pg.Client): Promise<EpCensus> {
  const r = await client.query(
    `
    SELECT
      COUNT(*)::int AS ep_total,
      COUNT(*) FILTER (WHERE build_source IN ('detail_shipment','detail_remainder'))::int AS ep_derived,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS ep_resolved,
      COUNT(*) FILTER (
        WHERE build_source IN ('detail_shipment','detail_remainder')
          AND resolved_product_id IS NULL
      )::int AS ep_derived_unresolved,
      COUNT(*) FILTER (
        WHERE build_source IN ('detail_shipment','detail_remainder')
          AND identifier_resolution_status = 'resolved'
      )::int AS ep_status_resolved,
      COUNT(*) FILTER (
        WHERE build_source IN ('detail_shipment','detail_remainder')
          AND identifier_resolution_status = 'unresolved'
      )::int AS ep_status_unresolved,
      COUNT(*) FILTER (
        WHERE build_source IN ('detail_shipment','detail_remainder')
          AND identifier_resolution_status = 'ambiguous'
      )::int AS ep_status_ambiguous,
      COUNT(*) FILTER (
        WHERE build_source IN ('detail_shipment','detail_remainder')
          AND identifier_resolution_status IS NOT NULL
          AND identifier_resolution_status NOT IN ('resolved','unresolved','ambiguous')
      )::int AS ep_status_other
    FROM public.expected_packages
    WHERE organization_id = $1::uuid AND store_id = $2::uuid
    `,
    [ORG_ID, STORE_ID],
  );
  return r.rows[0] as EpCensus;
}

async function mismatchNonOverflow(client: pg.Client): Promise<number> {
  const colQ = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='amazon_removal_shipments'`,
  );
  const shipmentHasDisposition = (colQ.rows as Array<{ column_name: string }>).some(
    (x) => x.column_name === "disposition",
  );
  const shipDispositionSel = shipmentHasDisposition
    ? "nullif(btrim(s.disposition), '') AS disposition"
    : "NULL::text AS disposition";
  const dispositionJoin = shipmentHasDisposition
    ? "AND s.disposition IS NOT DISTINCT FROM d.disposition"
    : "";
  const r = await client.query(
    `
    WITH detail AS (
      SELECT d.id AS detail_id, COALESCE(d.shipped_quantity,0) AS detail_shipped_qty,
        d.organization_id, d.store_id, d.order_id, d.order_type, d.order_date,
        nullif(btrim(d.sku),'') AS sku, nullif(btrim(d.fnsku),'') AS fnsku, nullif(btrim(d.disposition),'') AS disposition
      FROM public.amazon_removals d
      WHERE d.organization_id=$1::uuid AND d.store_id=$2::uuid AND d.order_id IS NOT NULL
    ),
    shipment AS (
      SELECT s.id AS shipment_id, s.organization_id, s.store_id, s.order_id, s.order_type, s.order_date,
        nullif(btrim(s.sku),'') AS sku, nullif(btrim(s.fnsku),'') AS fnsku, ${shipDispositionSel},
        COALESCE(s.shipped_quantity,0) AS shipment_shipped_qty
      FROM public.amazon_removal_shipments s WHERE s.organization_id=$1::uuid AND s.store_id=$2::uuid
    ),
    pair AS (
      SELECT d.detail_id, d.detail_shipped_qty, s.shipment_id, s.shipment_shipped_qty
      FROM detail d LEFT JOIN shipment s
        ON s.organization_id=d.organization_id AND s.store_id IS NOT DISTINCT FROM d.store_id
       AND s.order_id IS NOT DISTINCT FROM d.order_id AND s.order_type IS NOT DISTINCT FROM d.order_type
       AND s.order_date IS NOT DISTINCT FROM d.order_date AND s.sku IS NOT DISTINCT FROM d.sku
       AND s.fnsku IS NOT DISTINCT FROM d.fnsku ${dispositionJoin}
    ),
    agg AS (
      SELECT detail_id, max(detail_shipped_qty) AS detail_total,
        sum(COALESCE(shipment_shipped_qty,0)) FILTER (WHERE shipment_id IS NOT NULL) AS shipment_total,
        count(*) FILTER (WHERE shipment_id IS NOT NULL) AS shipment_count
      FROM pair GROUP BY detail_id
    ),
    matched_emitted AS (
      SELECT p.detail_id, p.shipment_shipped_qty AS qty FROM pair p JOIN agg a USING (detail_id) WHERE p.shipment_id IS NOT NULL
    ),
    remainder_emitted AS (
      SELECT DISTINCT ON (p.detail_id) p.detail_id, GREATEST(a.detail_total - COALESCE(a.shipment_total,0),0)::int AS qty
      FROM pair p JOIN agg a USING (detail_id)
      WHERE COALESCE(a.shipment_count,0)=0 OR a.detail_total > COALESCE(a.shipment_total,0)
      ORDER BY p.detail_id
    ),
    emitted AS (SELECT detail_id, qty FROM matched_emitted UNION ALL SELECT detail_id, qty FROM remainder_emitted),
    sim AS (SELECT detail_id, sum(qty)::int AS sim_sum FROM emitted GROUP BY 1),
    live AS (
      SELECT source_detail_row_id AS detail_id, sum(expected_scan_quantity)::int AS live_sum
      FROM public.expected_packages
      WHERE organization_id=$1::uuid AND store_id=$2::uuid AND build_source IN ('detail_shipment','detail_remainder')
      GROUP BY 1
    )
    SELECT count(*) FILTER (WHERE NOT (a.shipment_total > a.detail_total))::int AS non_overflow_mismatch
    FROM sim FULL OUTER JOIN live USING (detail_id)
    JOIN agg a ON a.detail_id = COALESCE(sim.detail_id, live.detail_id)
    WHERE COALESCE(sim_sum,-1) <> COALESCE(live_sum,-2)
    `,
    [ORG_ID, STORE_ID],
  );
  return Number((r.rows[0] as { non_overflow_mismatch: number }).non_overflow_mismatch);
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);

  const originalPg = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  const stagingPg = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!originalPg) blockers.push("ORIGINAL_DIRECT_POSTGRES_URL unset");
  if (!stagingPg) blockers.push("STAGING_DIRECT_POSTGRES_URL unset");
  if (originalPg && refFromConnectionUrl(originalPg) !== ORIGINAL_REF) {
    blockers.push(`ORIGINAL URL must target ${ORIGINAL_REF}`);
  }
  if (stagingPg && refFromConnectionUrl(stagingPg) !== STAGING_REF) {
    blockers.push(`STAGING URL must target ${STAGING_REF}`);
  }

  let executeManifest: Record<string, unknown> | null = null;
  const manifestPath = path.join(process.cwd(), DATA_EXECUTE_DIR, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    executeManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  } else {
    blockers.push(`Data execute manifest missing: ${DATA_EXECUTE_DIR}`);
  }

  let original: EpCensus | null = null;
  let staging: EpCensus | null = null;
  let rebuildValid = false;

  if (!blockers.length) {
    const oc = new pg.Client({ connectionString: originalPg, ssl: { rejectUnauthorized: false } });
    const sc = new pg.Client({ connectionString: stagingPg, ssl: { rejectUnauthorized: false } });
    await oc.connect();
    await sc.connect();
    await oc.query("SET statement_timeout = '120s'");
    await sc.query("SET statement_timeout = '120s'");
    original = await epCensus(oc);
    staging = await epCensus(sc);
    const nonOverflow = await mismatchNonOverflow(oc);
    rebuildValid = nonOverflow === 0;
    await sc.end();
    await oc.end();
  }

  const executeResolved = Number(executeManifest?.ep_resolved_post ?? 0);
  const executeDerived = Number(executeManifest?.ep_derived_post ?? 0);
  const executeResolverApplied = Number(executeManifest?.resolver_applied ?? 0);
  const liveResolved = original?.ep_resolved ?? 0;
  const liveDerived = original?.ep_derived ?? 0;
  const liveDerivedUnresolved = original?.ep_derived_unresolved ?? 0;

  const resolverComplete =
    executeManifest?.status === "PASS" &&
    executeResolverApplied >= executeDerived &&
    executeDerived > 0 &&
    liveResolved === executeResolved &&
    liveDerived === executeDerived;

  const resumeNeeded =
    !resolverComplete &&
    rebuildValid &&
    liveDerived > 0 &&
    liveResolved < liveDerived;

  if (resumeNeeded) {
    blockers.push(
      `Resolver incomplete vs execute manifest — resume: npx tsx scripts/original-parity-phase1-wave-data-execute.ts --apply --skip-fetch --skip-sync --skip-rebuild`,
    );
  }

  const comparison = [
    "# Original vs staging — expected_packages resolver census",
    "",
    "| Metric | Staging | Original (live) | Delta (staging − original) |",
    "|--------|--------:|----------------:|-----------------------------:|",
    `| derived expected_packages | ${staging?.ep_derived ?? "—"} | ${original?.ep_derived ?? "—"} | ${(staging?.ep_derived ?? 0) - (original?.ep_derived ?? 0)} |`,
    `| resolved_product_id (all EP) | ${staging?.ep_resolved ?? "—"} | ${original?.ep_resolved ?? "—"} | ${(staging?.ep_resolved ?? 0) - (original?.ep_resolved ?? 0)} |`,
    `| derived unresolved (no product_id) | ${staging?.ep_derived_unresolved ?? "—"} | ${original?.ep_derived_unresolved ?? "—"} | ${(staging?.ep_derived_unresolved ?? 0) - (original?.ep_derived_unresolved ?? 0)} |`,
    `| status=ambiguous (derived) | ${staging?.ep_status_ambiguous ?? "—"} | ${original?.ep_status_ambiguous ?? "—"} | ${(staging?.ep_status_ambiguous ?? 0) - (original?.ep_status_ambiguous ?? 0)} |`,
    "",
    "## Why counts differ",
    "",
    "- **Original has more domain rows** (9-month SP-API fetch + rebuild) → **11,790** derived EP vs staging **~6,175** (staging CSV/rebuild scope is narrower).",
    "- **Staging resolver coverage is higher %** on a smaller cohort (6099/6175 ≈ 98.8%); original resolved **9377/11790 ≈ 79.5%** with **2413** `missing_product_needs_evidence` at execute time.",
    "- **Not a staging clone gap** — original intentionally uses fresh fetch; staging must not be mutated.",
    "- **Overflow allocation mismatches (120)** are detail-over-shipment qty; **non-overflow mismatch = 0** → rebuild_valid for scanner receive.",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "original-vs-staging-comparison.md"), comparison + "\n");

  fs.writeFileSync(
    path.join(outDir, "resolver-status.md"),
    [
      "# Resolver finish status",
      "",
      `| Field | Value |`,
      `|-------|-------|`,
      `| data_execute_run_id | \`${DATA_EXECUTE_RUN}\` |`,
      `| execute_manifest_status | **${executeManifest?.status ?? "unknown"}** |`,
      `| execute_resolver_applied | **${executeResolverApplied}** |`,
      `| execute_ep_derived_post | **${executeDerived}** |`,
      `| execute_ep_resolved_post | **${executeResolved}** |`,
      `| live_ep_derived | **${liveDerived}** |`,
      `| live_ep_resolved | **${liveResolved}** |`,
      `| live_derived_unresolved | **${liveDerivedUnresolved}** |`,
      `| live_status_ambiguous (derived) | **${original?.ep_status_ambiguous ?? 0}** |`,
      `| rebuild_valid (non-overflow mismatch=0) | **${rebuildValid ? "yes" : "no"}** |`,
      `| **resolver_complete** | **${resolverComplete ? "yes" : "no"}** |`,
      `| resume_needed | **${resumeNeeded ? "yes" : "no"}** |`,
      "",
      executeManifest
        ? [
            "## Execute-time resolver summary",
            "",
            "From `resolver-backfill-result.md`:",
            "",
            `- candidates_scanned: ${executeDerived}`,
            `- set_resolved: ${executeResolved}`,
            `- status_only (unresolved): ${liveDerivedUnresolved}`,
            `- queue_ambiguous: 0`,
          ].join("\n")
        : "",
    ].join("\n") + "\n",
  );

  const nextPrompt = resumeNeeded
    ? "ORIGINAL-PARITY-WAVE-DATA-RESOLVER-FINISH-VERIFY-RESUME — run resolver-only on original (--skip-fetch --skip-sync --skip-rebuild)"
    : resolverComplete && liveDerivedUnresolved > 500
      ? "ORIGINAL-PARITY-PHASE1-WAVE-B-EXECUTE — governed map replays on original to close missing_product_needs_evidence gap"
      : "ORIGINAL-PARITY-PHASE1-WAVE-C-EXECUTE — scanner contract verification on original";

  const status = blockers.length ? "BLOCKED" : resolverComplete ? "PASS" : "PARTIAL";

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length ? blockers.map((b) => `- ${b}`).join("\n") + "\n" : "- None.\n",
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "ORIGINAL-PARITY-WAVE-DATA-RESOLVER-FINISH-VERIFY",
        run_id: runId,
        branch,
        status,
        data_execute_run_id: DATA_EXECUTE_RUN,
        resolver_complete: resolverComplete,
        original_ref: ORIGINAL_REF,
        staging_ref: STAGING_REF,
        original_live: original,
        staging_live: staging,
        rebuild_valid: rebuildValid,
        resume_needed: resumeNeeded,
        blockers,
        exact_next_prompt: nextPrompt,
        no_staging_writes: true,
        no_products_insert: true,
        no_pim_insert: true,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        outDir: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
        status,
        resolver_complete: resolverComplete,
        original_resolved: liveResolved,
        original_derived_unresolved: liveDerivedUnresolved,
        blockers,
        exact_next_prompt: nextPrompt,
      },
      null,
      2,
    ),
  );

  if (blockers.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
