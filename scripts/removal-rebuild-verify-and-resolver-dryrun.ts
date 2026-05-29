/**
 * REMOVAL REBUILD VERIFY + RESOLVER DRY-RUN (read-only)
 *
 *   npx tsx scripts/removal-rebuild-verify-and-resolver-dryrun.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  parseRemovalRawDataHints,
  resolveExpectedPackageProduct,
  type RemovalExpectedPackageRow,
} from "../lib/removal/resolve-expected-package-product";
import type { ScannerResolutionColumns } from "../lib/scanner-product-resolve";
import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const SAM_ORG = "00000000-0000-0000-0000-000000000001";
const SAM_STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/removal-rebuild-verify-and-resolver-dryrun";
const REBUILD_EXEC = ".cursor/audit-reports/removal-existing-csv-rebuild-execute/20260527T180332Z";
const PRIOR_RESOLVER_DRY = ".cursor/audit-reports/removal-expected-packages-resolver-backfill-dry-run/20260527T220000Z";
const DERIVED_SOURCES = ["detail_shipment", "detail_remainder"] as const;
const PRIOR_BASELINE = { resolved: 1602, missing_evidence: 24, derived_total: 1626 };

type InvariantRow = {
  check: string;
  status: "pass" | "fail" | "warn";
  count: number;
  sample?: unknown;
};

type BackfillProposal = {
  id: string;
  bucket: string;
  apply_kind: string;
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

function n(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

async function runAllocationInvariants(
  client: pg.Client,
): Promise<{
  invariants: InvariantRow[];
  epMismatchVsSim: number;
  orphanShipments: number;
  mismatchDetail: { total_mismatch: number; overflow_mismatch: number; non_overflow_mismatch: number };
}> {
  const invariants: InvariantRow[] = [];

  const colQ = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='amazon_removal_shipments'`,
  );
  const shipmentCols = (colQ.rows as Array<{ column_name: string }>).map((x) => x.column_name);
  const shipmentHasDisposition = shipmentCols.includes("disposition");
  const shipDispositionSel = shipmentHasDisposition
    ? "nullif(btrim(s.disposition), '') AS disposition"
    : "NULL::text AS disposition";
  const dispositionJoin = shipmentHasDisposition
    ? "AND s.disposition IS NOT DISTINCT FROM d.disposition"
    : "";

  const simRes = await client.query(
    `
    WITH detail AS (
      SELECT d.id AS detail_id, d.organization_id, d.store_id, d.order_id, d.order_type, d.order_date,
        nullif(btrim(d.sku), '') AS sku, nullif(btrim(d.fnsku), '') AS fnsku,
        nullif(btrim(d.disposition), '') AS disposition,
        COALESCE(d.shipped_quantity, 0) AS detail_shipped_qty
      FROM public.amazon_removals d
      WHERE d.organization_id = $1::uuid AND d.store_id = $2::uuid AND d.order_id IS NOT NULL
    ),
    shipment AS (
      SELECT s.id AS shipment_id, s.organization_id, s.store_id, s.order_id, s.order_type, s.order_date,
        nullif(btrim(s.sku), '') AS sku, nullif(btrim(s.fnsku), '') AS fnsku, ${shipDispositionSel},
        COALESCE(s.shipped_quantity, 0) AS shipment_shipped_qty
      FROM public.amazon_removal_shipments s
      WHERE s.organization_id = $1::uuid AND s.store_id = $2::uuid
    ),
    pair AS (
      SELECT d.detail_id, d.detail_shipped_qty, s.shipment_id, s.shipment_shipped_qty
      FROM detail d
      LEFT JOIN shipment s
        ON s.organization_id = d.organization_id AND s.store_id IS NOT DISTINCT FROM d.store_id
       AND s.order_id IS NOT DISTINCT FROM d.order_id AND s.order_type IS NOT DISTINCT FROM d.order_type
       AND s.order_date IS NOT DISTINCT FROM d.order_date AND s.sku IS NOT DISTINCT FROM d.sku
       AND s.fnsku IS NOT DISTINCT FROM d.fnsku ${dispositionJoin}
    ),
    agg AS (
      SELECT detail_id,
        max(detail_shipped_qty) AS detail_total,
        sum(COALESCE(shipment_shipped_qty, 0)) FILTER (WHERE shipment_id IS NOT NULL) AS shipment_total,
        count(*) FILTER (WHERE shipment_id IS NOT NULL) AS shipment_count
      FROM pair GROUP BY detail_id
    ),
    matched_emitted AS (
      SELECT p.detail_id, p.shipment_shipped_qty AS expected_scan_quantity
      FROM pair p JOIN agg a USING (detail_id) WHERE p.shipment_id IS NOT NULL
    ),
    remainder_emitted AS (
      SELECT DISTINCT ON (p.detail_id) p.detail_id,
        GREATEST(a.detail_total - COALESCE(a.shipment_total, 0), 0)::int AS expected_scan_quantity
      FROM pair p JOIN agg a USING (detail_id)
      WHERE COALESCE(a.shipment_count, 0) = 0 OR a.detail_total > COALESCE(a.shipment_total, 0)
      ORDER BY p.detail_id
    ),
    per_detail AS (
      SELECT a.detail_id, a.detail_total, a.shipment_count, a.shipment_total,
        coalesce((SELECT sum(expected_scan_quantity) FROM matched_emitted m WHERE m.detail_id = a.detail_id), 0)
          + coalesce((SELECT sum(expected_scan_quantity) FROM remainder_emitted r WHERE r.detail_id = a.detail_id), 0)
          AS sum_allocated,
        (SELECT count(*)::int FROM remainder_emitted r WHERE r.detail_id = a.detail_id) AS remainder_row_count,
        (a.shipment_total > a.detail_total) AS is_overflow
      FROM agg a
    )
    SELECT * FROM per_detail
    `,
    [SAM_ORG, SAM_STORE],
  );

  const perDetail = simRes.rows as Array<{
    detail_id: string;
    detail_total: number;
    shipment_count: number;
    shipment_total: number;
    sum_allocated: number;
    remainder_row_count: number;
    is_overflow: boolean;
  }>;

  const inv1Fails = perDetail.filter(
    (r) => !r.is_overflow && Number(r.sum_allocated) !== Number(r.detail_total),
  );
  invariants.push({
    check: "sum_allocated_equals_detail_when_not_overflow",
    status: inv1Fails.length ? "fail" : "pass",
    count: inv1Fails.length,
    sample: inv1Fails.slice(0, 3),
  });

  const inv3Fails = perDetail.filter((r) => Number(r.remainder_row_count) > 1);
  invariants.push({
    check: "at_most_one_remainder_row_per_detail",
    status: inv3Fails.length ? "fail" : "pass",
    count: inv3Fails.length,
  });

  const epCmp = await client.query(
    `
    WITH detail AS (
      SELECT d.id AS detail_id, COALESCE(d.shipped_quantity, 0) AS detail_shipped_qty,
        d.organization_id, d.store_id, d.order_id, d.order_type, d.order_date,
        nullif(btrim(d.sku),'') AS sku, nullif(btrim(d.fnsku),'') AS fnsku, nullif(btrim(d.disposition),'') AS disposition
      FROM public.amazon_removals d
      WHERE d.organization_id=$1::uuid AND d.store_id=$2::uuid AND d.order_id IS NOT NULL
    ),
    shipment AS (
      SELECT s.id AS shipment_id, s.organization_id, s.store_id, s.order_id, s.order_type, s.order_date,
        nullif(btrim(s.sku),'') AS sku, nullif(btrim(s.fnsku),'') AS fnsku, ${shipDispositionSel},
        COALESCE(s.shipped_quantity,0) AS shipment_shipped_qty
      FROM public.amazon_removal_shipments s
      WHERE s.organization_id=$1::uuid AND s.store_id=$2::uuid
    ),
    pair AS (
      SELECT d.detail_id, d.detail_shipped_qty, s.shipment_id, s.shipment_shipped_qty
      FROM detail d
      LEFT JOIN shipment s
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
      SELECT DISTINCT ON (p.detail_id) p.detail_id,
        GREATEST(a.detail_total - COALESCE(a.shipment_total,0),0)::int AS qty
      FROM pair p JOIN agg a USING (detail_id)
      WHERE COALESCE(a.shipment_count,0)=0 OR a.detail_total > COALESCE(a.shipment_total,0)
      ORDER BY p.detail_id
    ),
    emitted AS (
      SELECT detail_id, qty FROM matched_emitted
      UNION ALL SELECT detail_id, qty FROM remainder_emitted
    ),
    sim AS (SELECT detail_id, sum(qty)::int AS sim_sum FROM emitted GROUP BY 1),
    live AS (
      SELECT source_detail_row_id AS detail_id, sum(expected_scan_quantity)::int AS live_sum
      FROM public.expected_packages
      WHERE organization_id=$1::uuid AND store_id=$2::uuid
        AND build_source IN ('detail_shipment','detail_remainder')
      GROUP BY 1
    )
    SELECT count(*)::int AS c FROM sim FULL OUTER JOIN live USING (detail_id)
    WHERE COALESCE(sim_sum,-1) <> COALESCE(live_sum,-2)
    `,
    [SAM_ORG, SAM_STORE],
  );
  const epMismatchVsSim = (epCmp.rows[0] as { c: number }).c;

  const mismatchBreakdown = await client.query(
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
      FROM public.amazon_removal_shipments s
      WHERE s.organization_id=$1::uuid AND s.store_id=$2::uuid
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
      SELECT DISTINCT ON (p.detail_id) p.detail_id,
        GREATEST(a.detail_total - COALESCE(a.shipment_total,0),0)::int AS qty
      FROM pair p JOIN agg a USING (detail_id)
      WHERE COALESCE(a.shipment_count,0)=0 OR a.detail_total > COALESCE(a.shipment_total,0)
      ORDER BY p.detail_id
    ),
    emitted AS (
      SELECT detail_id, qty FROM matched_emitted UNION ALL SELECT detail_id, qty FROM remainder_emitted
    ),
    sim AS (SELECT detail_id, sum(qty)::int AS sim_sum FROM emitted GROUP BY 1),
    live AS (
      SELECT source_detail_row_id AS detail_id, sum(expected_scan_quantity)::int AS live_sum
      FROM public.expected_packages
      WHERE organization_id=$1::uuid AND store_id=$2::uuid AND build_source IN ('detail_shipment','detail_remainder')
      GROUP BY 1
    )
    SELECT count(*)::int AS total_mismatch,
      count(*) FILTER (WHERE a.shipment_total > a.detail_total)::int AS overflow_mismatch,
      count(*) FILTER (WHERE NOT (a.shipment_total > a.detail_total))::int AS non_overflow_mismatch
    FROM sim FULL OUTER JOIN live USING (detail_id)
    JOIN agg a ON a.detail_id = COALESCE(sim.detail_id, live.detail_id)
    WHERE COALESCE(sim_sum,-1) <> COALESCE(live_sum,-2)
    `,
    [SAM_ORG, SAM_STORE],
  );
  const mismatchDetail = mismatchBreakdown.rows[0] as {
    total_mismatch: number;
    overflow_mismatch: number;
    non_overflow_mismatch: number;
  };

  invariants.push({
    check: "live_derived_qty_matches_simulation_per_detail",
    status: epMismatchVsSim === 0 ? "pass" : "fail",
    count: epMismatchVsSim,
    sample: mismatchDetail,
  });

  const orphanRes = await client.query(
    `
    WITH detail AS (
      SELECT d.organization_id, d.store_id, d.order_id, d.order_type, d.order_date,
        nullif(btrim(d.sku),'') AS sku, nullif(btrim(d.fnsku),'') AS fnsku, nullif(btrim(d.disposition),'') AS disposition
      FROM public.amazon_removals d WHERE d.organization_id=$1::uuid AND d.store_id=$2::uuid
    ),
    shipment AS (
      SELECT s.id, s.organization_id, s.store_id, s.order_id, s.order_type, s.order_date,
        nullif(btrim(s.sku),'') AS sku, nullif(btrim(s.fnsku),'') AS fnsku, ${shipDispositionSel}
      FROM public.amazon_removal_shipments s WHERE s.organization_id=$1::uuid AND s.store_id=$2::uuid
    )
    SELECT count(*)::int AS c FROM shipment s
    WHERE NOT EXISTS (
      SELECT 1 FROM detail d
      WHERE d.organization_id=s.organization_id AND d.store_id IS NOT DISTINCT FROM s.store_id
        AND d.order_id IS NOT DISTINCT FROM s.order_id AND d.order_type IS NOT DISTINCT FROM s.order_type
        AND d.order_date IS NOT DISTINCT FROM s.order_date AND d.sku IS NOT DISTINCT FROM s.sku
        AND d.fnsku IS NOT DISTINCT FROM s.fnsku
        ${shipmentHasDisposition ? "AND d.disposition IS NOT DISTINCT FROM s.disposition" : ""}
    )
    `,
    [SAM_ORG, SAM_STORE],
  );
  const orphanShipments = (orphanRes.rows[0] as { c: number }).c;
  invariants.push({
    check: "orphan_shipments_without_detail_match",
    status: orphanShipments > 0 ? "warn" : "pass",
    count: orphanShipments,
  });

  return { invariants, epMismatchVsSim, orphanShipments, mismatchDetail };
}

async function epBuildSourceCounts(client: pg.Client) {
  const r = await client.query(
    `
    SELECT
      COUNT(*)::int AS derived_total,
      COUNT(*) FILTER (WHERE build_source = 'detail_shipment')::int AS detail_shipment,
      COUNT(*) FILTER (WHERE build_source = 'detail_remainder')::int AS detail_remainder,
      COUNT(*) FILTER (WHERE build_status = 'shipment_overflow_conflict')::int AS overflow_conflict,
      COUNT(*) FILTER (WHERE build_status = 'matched')::int AS status_matched,
      COUNT(*) FILTER (WHERE build_status = 'awaiting_shipment_match')::int AS status_awaiting,
      COUNT(*) FILTER (WHERE build_status = 'no_shipment_expected')::int AS status_no_shipment
    FROM public.expected_packages
    WHERE organization_id = $1::uuid AND store_id = $2::uuid
      AND build_source IN ('detail_shipment', 'detail_remainder')
    `,
    [SAM_ORG, SAM_STORE],
  );
  return r.rows[0] as Record<string, number>;
}

async function fetchCandidateRows(
  client: pg.Client,
  cursor: string,
  limit: number,
): Promise<RemovalExpectedPackageRow[]> {
  const res = await client.query(
    `SELECT id::text, organization_id::text, store_id::text, sku, fnsku,
      resolved_product_id::text, resolved_catalog_product_id::text,
      identifier_resolution_status, identifier_resolution_confidence::text,
      source_detail_row_id::text, order_id, build_source
     FROM public.expected_packages
     WHERE build_source = ANY($3::text[])
       AND organization_id = $4::uuid AND store_id = $5::uuid
       AND id > $1::uuid
     ORDER BY id LIMIT $2`,
    [cursor, limit, DERIVED_SOURCES, SAM_ORG, SAM_STORE],
  );
  return res.rows as RemovalExpectedPackageRow[];
}

async function fetchRemovalHydration(client: pg.Client, detailIds: string[]) {
  const out = new Map<string, { asin: string | null; upc: string | null }>();
  if (!detailIds.length) return out;
  const CHUNK = 500;
  for (let i = 0; i < detailIds.length; i += CHUNK) {
    const slice = detailIds.slice(i, i + CHUNK);
    const r = await client.query(
      `SELECT id::text, raw_data FROM public.amazon_removals WHERE id = ANY($1::uuid[])`,
      [slice],
    );
    for (const row of r.rows) {
      const hints = parseRemovalRawDataHints(row.raw_data);
      out.set(String(row.id), hints);
    }
  }
  return out;
}

async function productExists(client: pg.Client, productId: string): Promise<boolean> {
  const r = await client.query(`SELECT 1 FROM public.products WHERE id = $1::uuid LIMIT 1`, [productId]);
  return r.rows.length > 0;
}

async function runResolverDryRun(
  client: pg.Client,
  supabase: ReturnType<typeof createClient>,
): Promise<{ proposals: BackfillProposal[]; summary: Record<string, number> }> {
  const proposals: BackfillProposal[] = [];
  let cursor = "00000000-0000-0000-0000-000000000000";
  const PAGE = 500;
  const CONCURRENCY = 32;

  async function resolveOne(row: RemovalExpectedPackageRow, hydration: Map<string, { asin: string | null; upc: string | null }>): Promise<BackfillProposal> {
    const detailId = n(row.source_detail_row_id);
    const removalHints = detailId ? hydration.get(detailId) : undefined;
    const resolved = await resolveExpectedPackageProduct(supabase, row, {
      asinFromRemoval: removalHints?.asin ?? null,
      upcFromRemoval: removalHints?.upc ?? null,
    });

    let after: ScannerResolutionColumns = { ...resolved.columns };
    let apply_kind = "status_only";

    if (after.identifier_resolution_status === "resolved" && after.resolved_product_id) {
      const ok = await productExists(client, after.resolved_product_id);
      if (ok) apply_kind = "set_resolved";
      else {
        after = {
          ...after,
          resolved_product_id: null,
          resolved_catalog_product_id: null,
          identifier_resolution_status: "unresolved",
        };
      }
    }

    return { id: row.id, bucket: resolved.bucket, apply_kind };
  }

  async function mapPool<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let i = 0;
    async function worker() {
      for (;;) {
        const idx = i++;
        if (idx >= items.length) return;
        out[idx] = await fn(items[idx]!);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, () => worker()));
    return out;
  }

  for (;;) {
    const batch = await fetchCandidateRows(client, cursor, PAGE);
    if (!batch.length) break;

    const detailIds = [
      ...new Set(batch.map((r) => n(r.source_detail_row_id)).filter((x): x is string => !!x)),
    ];
    const hydration = await fetchRemovalHydration(client, detailIds);
    proposals.push(...(await mapPool(batch, (row) => resolveOne(row, hydration))));

    cursor = batch[batch.length - 1]!.id;
    if (batch.length < PAGE) break;
  }

  const summary = {
    candidates_scanned: proposals.length,
    queue_resolved: proposals.filter((p) => p.bucket === "resolved").length,
    queue_ambiguous: proposals.filter((p) => p.bucket === "ambiguous").length,
    queue_missing_product_needs_evidence: proposals.filter(
      (p) => p.bucket === "missing_product_needs_evidence",
    ).length,
    set_resolved: proposals.filter((p) => p.apply_kind === "set_resolved").length,
  };
  return { proposals, summary };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const publicUrl =
    process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const blockers: string[] = [];

  if (!dbUrl || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    blockers.push(`STAGING_DIRECT_POSTGRES_URL must target ${STAGING_REF}`);
  }
  if (dbUrl.includes(ORIGINAL_REF)) blockers.push("Must not use original project URL");
  if (refFromSupabaseUrl(publicUrl) && refFromSupabaseUrl(publicUrl) !== STAGING_REF) {
    blockers.push(`Supabase URL must be staging ${STAGING_REF}`);
  }
  if (getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    blockers.push("Staging ref guard failed");
  }

  if (blockers.length) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.map((b) => `- ${b}`).join("\n") + "\n");
    throw new Error(blockers.join("; "));
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '600s'");

  const buildCounts = await epBuildSourceCounts(client);
  const { invariants, epMismatchVsSim, orphanShipments, mismatchDetail } =
    await runAllocationInvariants(client);

  const supabase = createClient(
    publicUrl,
    process.env.STAGING_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "",
    { auth: { persistSession: false } },
  );

  const { proposals, summary: resolverSummary } = await runResolverDryRun(client, supabase);
  await client.end();

  const invariantFails = invariants.filter((i) => i.status === "fail");
  const nonOverflowMismatch = mismatchDetail?.non_overflow_mismatch ?? epMismatchVsSim;
  const rebuildValid =
    invariantFails.filter((i) => i.check !== "live_derived_qty_matches_simulation_per_detail").length ===
      0 &&
    nonOverflowMismatch === 0;

  const priorResolvedRate =
    PRIOR_BASELINE.derived_total > 0
      ? PRIOR_BASELINE.resolved / PRIOR_BASELINE.derived_total
      : 0;
  const currentResolvedRate =
    buildCounts.derived_total > 0 ? resolverSummary.queue_resolved / buildCounts.derived_total : 0;

  const nextPrompt = rebuildValid
    ? "REMOVAL-EXPECTED-PACKAGES-RESOLVER-BACKFILL-EXECUTE — set approval true and rerun resolver backfill with --execute"
    : "REMOVAL-REBUILD-INVESTIGATE — allocation invariant failures require review before resolver execute";

  fs.writeFileSync(path.join(outDir, "allocation-invariants.json"), JSON.stringify(invariants, null, 2));
  fs.writeFileSync(path.join(outDir, "build-source-counts.json"), JSON.stringify(buildCounts, null, 2));
  fs.writeFileSync(path.join(outDir, "resolver-summary.json"), JSON.stringify(resolverSummary, null, 2));
  fs.writeFileSync(
    path.join(outDir, "prior-comparison.md"),
    [
      "# Prior resolver dry-run comparison",
      "",
      "| Metric | Prior (pre-rebuild, ~1626 rows) | Post-rebuild |",
      "|--------|----------------------------------|--------------|",
      `| Derived EP rows | ${PRIOR_BASELINE.derived_total} | **${buildCounts.derived_total}** |`,
      `| Resolver resolved (dry-run) | ${PRIOR_BASELINE.resolved} | **${resolverSummary.queue_resolved}** |`,
      `| Missing evidence (dry-run) | ${PRIOR_BASELINE.missing_evidence} | **${resolverSummary.queue_missing_product_needs_evidence}** |`,
      `| Resolved rate | ${(priorResolvedRate * 100).toFixed(1)}% | ${(currentResolvedRate * 100).toFixed(1)}% |`,
      "",
      "Prior artifact refs:",
      `- Rebuild execute: \`${REBUILD_EXEC}\``,
      `- Prior resolver dry-run: \`${PRIOR_RESOLVER_DRY}\``,
      "",
      "Note: row count grew after rebuild (detail×shipment grain); missing-evidence count may scale with unique identifier gaps, not row count.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      "# Removal rebuild verify + resolver dry-run",
      "",
      `| Field | Value |`,
      `|-------|-------|`,
      `| rebuild_valid | **${rebuildValid ? "yes" : "no"}** |`,
      `| expected_packages (derived) | ${buildCounts.derived_total} |`,
      `| detail_shipment | ${buildCounts.detail_shipment} |`,
      `| detail_remainder | ${buildCounts.detail_remainder} |`,
      `| shipment_overflow_conflict rows | ${buildCounts.overflow_conflict} |`,
      `| live vs sim mismatch (detail lines) | ${epMismatchVsSim} |`,
      `| orphan shipments | ${orphanShipments} |`,
      `| resolver resolved (dry-run) | ${resolverSummary.queue_resolved} |`,
      `| missing evidence (dry-run) | ${resolverSummary.queue_missing_product_needs_evidence} |`,
      `| ambiguous (dry-run) | ${resolverSummary.queue_ambiguous} |`,
      "",
      `**Next prompt:** ${nextPrompt}`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "REMOVAL REBUILD VERIFY + RESOLVER DRY-RUN",
        run_id: runId,
        staging_ref: STAGING_REF,
        status: rebuildValid ? "PASS" : "FAIL",
        rebuild_valid: rebuildValid,
        rebuild_exec_ref: REBUILD_EXEC,
        expected_packages_derived_count: buildCounts.derived_total,
        build_source: {
          detail_shipment: buildCounts.detail_shipment,
          detail_remainder: buildCounts.detail_remainder,
        },
        overflow_conflict_count: buildCounts.overflow_conflict,
        ep_mismatch_vs_simulation: epMismatchVsSim,
        resolver_resolved_count: resolverSummary.queue_resolved,
        resolver_missing_evidence_count: resolverSummary.queue_missing_product_needs_evidence,
        resolver_ambiguous_count: resolverSummary.queue_ambiguous,
        prior_baseline: PRIOR_BASELINE,
        no_db_writes: true,
        exact_next_prompt: nextPrompt,
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "queue-missing-product-needs-evidence.jsonl"),
    proposals
      .filter((p) => p.bucket === "missing_product_needs_evidence")
      .map((p) => JSON.stringify({ expected_package_id: p.id, bucket: p.bucket }))
      .join("\n") + (resolverSummary.queue_missing_product_needs_evidence ? "\n" : ""),
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        outDir: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
        rebuild_valid: rebuildValid,
        expected_packages_count: buildCounts.derived_total,
        resolver_resolved_count: resolverSummary.queue_resolved,
        missing_evidence_count: resolverSummary.queue_missing_product_needs_evidence,
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
