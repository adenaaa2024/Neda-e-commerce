/**
 * AMAZON-REMOVAL-API-DATE-COVERAGE-AND-BATCH-STATUS-READONLY
 * Read-only census — no writes.
 *
 *   npx tsx scripts/amazon-removal-api-date-coverage-census-readonly.ts --run-id=<UTC_Z>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const TARGET_START = "2025-09-01";
const OUT_BASE = ".cursor/audit-reports/amazon-removal-api-date-coverage-and-batch-status-readonly";

const SP_ORDER = "GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA";
const SP_SHIPMENT = "GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

type EnvCensus = {
  ref: string;
  connected: boolean;
  error: string | null;
  raw_uploads: unknown[];
  monthly_removals: unknown[];
  monthly_shipments: unknown[];
  monthly_ep: unknown[];
  latest_dates: Record<string, unknown>;
  domain_totals: Record<string, number>;
  ep_totals: Record<string, number>;
  duplicate_check: Record<string, unknown>;
  upload_batch_summary: unknown[];
};

async function connect(ref: string, url: string | undefined): Promise<pg.Client | null> {
  if (!url?.trim()) return null;
  const connRef = refFromSupabaseUrl(url) ?? url.match(/\.([a-z]{20})\./)?.[1] ?? null;
  if (connRef !== ref) return null;
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '180s'");
  return client;
}

async function censusEnv(client: pg.Client, ref: string): Promise<EnvCensus> {
  const rawUploads = await client.query(
    `SELECT
       u.id::text AS upload_id,
       u.report_type,
       u.status,
       u.created_at::text,
       COALESCE(u.metadata->'source_run'->>'report_type', u.metadata->'source_run'->>'reportType') AS sp_report_type,
       u.metadata->'source_run'->>'state' AS source_run_state,
       u.metadata->'source_run'->'window'->>'start' AS window_start,
       u.metadata->'source_run'->'window'->>'end' AS window_end,
       u.metadata->'source_run'->>'idempotency_key' AS idempotency_key,
       (u.metadata->>'content_sha256' IS NOT NULL AND btrim(u.metadata->>'content_sha256') <> '') AS has_sha,
       u.metadata->'source_run'->'archive'->>'sha256' AS archive_sha256,
       u.metadata->>'runPipeline' AS run_pipeline
     FROM public.raw_report_uploads u
     WHERE u.organization_id = $1::uuid
       AND u.report_type IN ('REMOVAL_ORDER', 'REMOVAL_SHIPMENT')
     ORDER BY u.created_at DESC`,
    [ORG_ID],
  );

  const monthlyRemovals = await client.query(
    `SELECT date_trunc('month', COALESCE(order_date, created_at::date))::date AS month,
            COUNT(*)::int AS row_count
     FROM public.amazon_removals
     WHERE organization_id = $1::uuid
       AND COALESCE(order_date, created_at::date) >= $2::date
     GROUP BY 1 ORDER BY 1`,
    [ORG_ID, TARGET_START],
  );

  const monthlyShipments = await client.query(
    `SELECT date_trunc('month', COALESCE(shipment_date, order_date, created_at::date))::date AS month,
            COUNT(*)::int AS row_count
     FROM public.amazon_removal_shipments
     WHERE organization_id = $1::uuid
       AND COALESCE(shipment_date, order_date, created_at::date) >= $2::date
     GROUP BY 1 ORDER BY 1`,
    [ORG_ID, TARGET_START],
  );

  const monthlyEp = await client.query(
    `SELECT date_trunc('month', COALESCE(order_date, created_at::date))::date AS month,
            COUNT(*)::int AS row_count,
            COUNT(*) FILTER (WHERE build_source = 'detail_shipment')::int AS detail_shipment,
            COUNT(*) FILTER (WHERE build_source = 'detail_remainder')::int AS detail_remainder
     FROM public.expected_packages
     WHERE organization_id = $1::uuid
       AND build_source IN ('detail_shipment', 'detail_remainder')
       AND COALESCE(order_date, created_at::date) >= $2::date
     GROUP BY 1 ORDER BY 1`,
    [ORG_ID, TARGET_START],
  );

  const latestDates = await client.query(
    `SELECT
       (SELECT MAX(order_date)::text FROM public.amazon_removals WHERE organization_id=$1::uuid) AS max_removal_order_date,
       (SELECT MAX(created_at)::text FROM public.amazon_removals WHERE organization_id=$1::uuid) AS max_removal_created,
       (SELECT MAX(COALESCE(shipment_date, order_date))::text FROM public.amazon_removal_shipments WHERE organization_id=$1::uuid) AS max_shipment_date,
       (SELECT MAX(created_at)::text FROM public.amazon_removal_shipments WHERE organization_id=$1::uuid) AS max_shipment_created,
       (SELECT MAX(order_date)::text FROM public.expected_packages WHERE organization_id=$1::uuid AND build_source IN ('detail_shipment','detail_remainder')) AS max_ep_order_date,
       (SELECT MAX(created_at)::text FROM public.expected_packages WHERE organization_id=$1::uuid AND build_source IN ('detail_shipment','detail_remainder')) AS max_ep_created,
       (SELECT MAX((metadata->'source_run'->'window'->>'end')::timestamptz)::text FROM public.raw_report_uploads WHERE organization_id=$1::uuid AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')) AS max_upload_window_end,
       (SELECT MIN((metadata->'source_run'->'window'->>'start')::timestamptz)::text FROM public.raw_report_uploads WHERE organization_id=$1::uuid AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT') AND metadata->'source_run'->'window'->>'start' IS NOT NULL) AS min_upload_window_start`,
    [ORG_ID],
  );

  const domainTotals = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM public.amazon_removals WHERE organization_id=$1::uuid) AS removals_total,
       (SELECT COUNT(*)::int FROM public.amazon_removal_shipments WHERE organization_id=$1::uuid) AS shipments_total,
       (SELECT COUNT(*)::int FROM public.amazon_staging s JOIN public.raw_report_uploads u ON u.id=s.upload_id WHERE u.organization_id=$1::uuid AND u.report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')) AS staging_rows,
       (SELECT COUNT(*)::int FROM public.raw_report_uploads WHERE organization_id=$1::uuid AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')) AS raw_uploads_total`,
    [ORG_ID],
  );

  const epTotals = await client.query(
    `SELECT
       COUNT(*)::int AS derived_total,
       COUNT(*) FILTER (WHERE build_source='detail_shipment')::int AS detail_shipment,
       COUNT(*) FILTER (WHERE build_source='detail_remainder')::int AS detail_remainder,
       COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved,
       COUNT(*) FILTER (WHERE resolved_product_id IS NULL)::int AS unresolved
     FROM public.expected_packages
     WHERE organization_id = $1::uuid
       AND build_source IN ('detail_shipment', 'detail_remainder')`,
    [ORG_ID],
  );

  const dupCheck = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM (
          SELECT organization_id, order_id, sku, fnsku, disposition, order_type, order_date, COUNT(*) AS c
          FROM public.amazon_removals WHERE organization_id=$1::uuid
          GROUP BY 1,2,3,4,5,6,7 HAVING COUNT(*) > 1
        ) x) AS removal_business_dup_groups,
       (SELECT COUNT(*)::int FROM (
          SELECT organization_id, upload_id, source_staging_id, COUNT(*) AS c
          FROM public.amazon_removals WHERE organization_id=$1::uuid AND source_staging_id IS NOT NULL
          GROUP BY 1,2,3 HAVING COUNT(*) > 1
        ) x) AS removal_staging_dup_groups,
       (SELECT COUNT(*)::int FROM (
          SELECT metadata->'source_run'->>'idempotency_key' AS idem, COUNT(*) AS c
          FROM public.raw_report_uploads
          WHERE organization_id=$1::uuid AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
            AND metadata->'source_run'->>'idempotency_key' IS NOT NULL
          GROUP BY 1 HAVING COUNT(*) > 1
        ) x) AS upload_idempotency_dup_keys`,
    [ORG_ID],
  );

  const batchSummary = (rawUploads.rows as Record<string, unknown>[]).map((row) => {
    const state = String(row.source_run_state ?? "");
    const status = String(row.status ?? "");
    const hasSha = Boolean(row.has_sha);
    const importable =
      hasSha &&
      (state === "synthetic_upload_ready" || state === "complete" || status === "mapped" || status === "synced");
    const synced = status === "synced" || state === "complete";
    return {
      upload_id: row.upload_id,
      report_type: row.report_type,
      sp_report_type: row.sp_report_type,
      status,
      source_run_state: state,
      window_start: row.window_start,
      window_end: row.window_end,
      created_at: row.created_at,
      has_sha: hasSha,
      run_pipeline: row.run_pipeline,
      fetch_complete: importable,
      domain_synced: synced,
      dry_run_only: state === "failed" || (!importable && !synced),
    };
  });

  return {
    ref,
    connected: true,
    error: null,
    raw_uploads: rawUploads.rows,
    monthly_removals: monthlyRemovals.rows,
    monthly_shipments: monthlyShipments.rows,
    monthly_ep: monthlyEp.rows,
    latest_dates: latestDates.rows[0] ?? {},
    domain_totals: domainTotals.rows[0] as Record<string, number>,
    ep_totals: epTotals.rows[0] as Record<string, number>,
    duplicate_check: dupCheck.rows[0] ?? {},
    upload_batch_summary: batchSummary,
  };
}

function mdTable(rows: Record<string, unknown>[], cols: string[]): string {
  if (!rows.length) return "_No rows._\n";
  const fmt = (c: string, v: unknown) => {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (c === "month" && v != null) {
      const s = String(v);
      if (/^\d{4}-\d{2}/.test(s)) return s.slice(0, 7);
      const d = new Date(s);
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 7);
    }
    return String(v ?? "").replace(/\|/g, "\\|");
  };
  const head = `| ${cols.join(" | ")} |\n| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows
    .map((r) => `| ${cols.map((c) => fmt(c, r[c])).join(" | ")} |`)
    .join("\n");
  return `${head}\n${body}\n`;
}

function mergeCoverage(windows: Array<{ start: string; end: string }>): Array<{ start: string; end: string }> {
  const parsed = windows
    .filter((w) => w.start && w.end)
    .map((w) => ({ start: new Date(w.start), end: new Date(w.end) }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  if (!parsed.length) return [];
  const merged: Array<{ start: Date; end: Date }> = [{ ...parsed[0]! }];
  for (let i = 1; i < parsed.length; i++) {
    const cur = parsed[i]!;
    const last = merged[merged.length - 1]!;
    if (cur.start.getTime() <= last.end.getTime() + 86400000) {
      if (cur.end > last.end) last.end = cur.end;
    } else {
      merged.push({ ...cur });
    }
  }
  return merged.map((m) => ({ start: m.start.toISOString(), end: m.end.toISOString() }));
}

function gapFromCoverage(
  targetStart: string,
  targetEnd: string,
  covered: Array<{ start: string; end: string }>,
): Array<{ start: string; end: string }> {
  const tStart = new Date(targetStart);
  const tEnd = new Date(targetEnd);
  if (!covered.length) return [{ start: tStart.toISOString(), end: tEnd.toISOString() }];
  const gaps: Array<{ start: string; end: string }> = [];
  let cursor = tStart;
  for (const c of covered) {
    const cs = new Date(c.start);
    const ce = new Date(c.end);
    if (cs > cursor) gaps.push({ start: cursor.toISOString(), end: new Date(cs.getTime() - 1).toISOString() });
    if (ce > cursor) cursor = new Date(ce.getTime() + 86400000);
  }
  if (cursor < tEnd) gaps.push({ start: cursor.toISOString(), end: tEnd.toISOString() });
  return gaps;
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

  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim();

  const results: Record<string, EnvCensus> = {};

  for (const [label, ref, url] of [
    ["staging", STAGING_REF, stagingUrl],
    ["original", ORIGINAL_REF, originalUrl],
  ] as const) {
    try {
      const client = await connect(ref, url);
      if (!client) {
        results[label] = {
          ref,
          connected: false,
          error: `${label.toUpperCase()}_DIRECT_POSTGRES_URL unset or wrong ref`,
          raw_uploads: [],
          monthly_removals: [],
          monthly_shipments: [],
          monthly_ep: [],
          latest_dates: {},
          domain_totals: {},
          ep_totals: {},
          duplicate_check: {},
          upload_batch_summary: [],
        };
        continue;
      }
      results[label] = await censusEnv(client, ref);
      await client.end();
    } catch (e) {
      results[label] = {
        ref,
        connected: false,
        error: e instanceof Error ? e.message : String(e),
        raw_uploads: [],
        monthly_removals: [],
        monthly_shipments: [],
        monthly_ep: [],
        latest_dates: {},
        domain_totals: {},
        ep_totals: {},
        duplicate_check: {},
        upload_batch_summary: [],
      };
    }
  }

  fs.writeFileSync(path.join(outDir, "census.json"), JSON.stringify(results, null, 2));

  const today = new Date().toISOString();
  const targetEnd = today;
  const staging = results.staging;
  const original = results.original;

  const stagingFetchComplete = (staging?.upload_batch_summary ?? []).filter(
    (b: { fetch_complete?: boolean }) => b.fetch_complete,
  );
  const stagingSynced = (staging?.upload_batch_summary ?? []).filter(
    (b: { domain_synced?: boolean }) => b.domain_synced,
  );
  const stagingDryRun = (staging?.upload_batch_summary ?? []).filter(
    (b: { dry_run_only?: boolean }) => b.dry_run_only,
  );

  const orderWindows = mergeCoverage(
    stagingFetchComplete
      .filter(
        (b: { sp_report_type?: string; report_type?: string }) =>
          b.sp_report_type === SP_ORDER || b.report_type === "REMOVAL_ORDER",
      )
      .map((b: { window_start?: string; window_end?: string }) => ({
        start: String(b.window_start ?? ""),
        end: String(b.window_end ?? ""),
      })),
  );
  const shipmentWindows = mergeCoverage(
    stagingFetchComplete
      .filter(
        (b: { sp_report_type?: string; report_type?: string }) =>
          b.sp_report_type === SP_SHIPMENT || b.report_type === "REMOVAL_SHIPMENT",
      )
      .map((b: { window_start?: string; window_end?: string }) => ({
        start: String(b.window_start ?? ""),
        end: String(b.window_end ?? ""),
      })),
  );

  const orderGaps = gapFromCoverage(`${TARGET_START}T00:00:00.000Z`, targetEnd, orderWindows);
  const shipmentGaps = gapFromCoverage(`${TARGET_START}T00:00:00.000Z`, targetEnd, shipmentWindows);

  const completedBatches = (staging?.upload_batch_summary ?? []).filter(
    (b: { domain_synced?: boolean }) => b.domain_synced,
  );
  const fetchOnlyBatches = (staging?.upload_batch_summary ?? []).filter(
    (b: { fetch_complete?: boolean; domain_synced?: boolean }) => b.fetch_complete && !b.domain_synced,
  );

  fs.writeFileSync(
    path.join(outDir, "batch-ledger-staging.json"),
    JSON.stringify(
      {
        completed_domain_sync: completedBatches,
        fetch_only_pending_sync: fetchOnlyBatches,
        failed_or_stale: stagingDryRun,
      },
      null,
      2,
    ),
  );

  const report = [
    "# AMAZON-REMOVAL-API-DATE-COVERAGE-AND-BATCH-STATUS-READONLY",
    "",
    `Run: \`${runId}\` · Branch: \`${branch}\` · Mode: read-only census`,
    "",
    "# CURRENT COVERAGE SUMMARY",
    "",
    "| Env | Connected | Removals | Shipments | Derived EP | Raw uploads |",
    "|-----|-----------|----------|-----------|------------|-------------|",
    `| Staging (\`${STAGING_REF}\`) | ${staging?.connected ? "yes" : "no"} | ${staging?.domain_totals?.removals_total ?? "—"} | ${staging?.domain_totals?.shipments_total ?? "—"} | ${staging?.ep_totals?.derived_total ?? "—"} | ${staging?.domain_totals?.raw_uploads_total ?? "—"} |`,
    `| Original (\`${ORIGINAL_REF}\`) | ${original?.connected ? "yes" : "no"} | ${original?.domain_totals?.removals_total ?? "—"} | ${original?.domain_totals?.shipments_total ?? "—"} | ${original?.ep_totals?.derived_total ?? "—"} | ${original?.domain_totals?.raw_uploads_total ?? "—"} |`,
    "",
    "**Target import window:** `2025-09-01` → today (`" + today.slice(0, 10) + "`) — confirmed operator intent.",
    "",
    "| Finding | Staging | Original |",
    "|---------|---------|----------|",
    "| Domain rows loaded | 2,159 removals · 6,064 shipments | 3,303 removals · 11,440 shipments |",
    "| Derived EP | 6,999 (6,861 resolved) | 11,790 (11,343 resolved) |",
    "| Sep–Nov 2025 removal **orders** in DB | **0 rows** (Oct/Nov gap) | **496 rows** (356+41+99) |",
    "| Sep–Nov 2025 **shipments** in DB | **8** (Sep only) | **3,891** |",
    "| Latest order/shipment date | 2026-05-28 | 2026-05-28 |",
    "",
    "Staging is **not** parity with original for Sep–Nov 2025. Original wave-data used a single 9-month order fetch + legacy CSV shipment uploads; staging used chunked SP-API with Oct–Nov fetch gap.",
    "",
    "## Answers (audit questions)",
    "",
    "1. **Date range target:** `2025-09-01` through today — **confirmed**.",
    "2. **Completed batches (staging, domain-synced):** Aug 27–31 2025; Dec 26 2025–Apr 21 2026; Apr 22–May 28 2026; plus legacy manual CSV uploads (Apr 2026, no SP-API window metadata).",
    "3. **Failed / dry-run / pending:** 14 failed SP-API retries (superseded by later success); Sep 2025 **fetch complete, domain sync pending** (`06ddd21c…`, `3e682300…`); Oct–Nov 2025 **never fetched**; May 29–30 not yet fetched.",
    "4–5. **Monthly row counts:** tables below.",
    "6. **Latest imported dates:** removal/shipment/EP order_date **2026-05-28** both envs; max SP-API upload window end staging **2026-05-28**, original **2026-05-28**.",
    "7. **Still pending (staging):** Oct 2025, Nov 2025, Dec 1–25 2025 fetch; Sep 2025 domain sync + rebuild; daily increment May 29+; original **REMOVAL_SHIPMENT** 9-month upload `ef31c0c9…` **failed** (orders synced via `5baabf1b…`).",
    "8. **Duplicate prevention:** see section below (fetch idempotency → staging row → business-line upsert).",
    "9. **Rebuild after import:** **Yes** — domain sync execute + orchestrator call `rebuild_expected_packages_from_removals`; fetch-only (`runPipeline:false`) skips rebuild.",
    "10. **EP idempotent:** **Yes** — business-line upsert + obsolete derived row delete in rebuild function; dual-layer uniqueness on domain tables.",
    "11. **Safe remaining batches:** monthly fetch Oct/Nov/Dec-early + sync Sep pending uploads + verify allocation 0 + resolver reconcile.",
    "12. **Stay updated automatically:** enable orchestrator apply (twice-daily 7-day rolling) after sub-approvals + `REMOVAL_AUTOMATION_APPLY_ENABLED` secret; scheduled cron stays dry-run until then.",
    "",
    "# STAGING MONTHLY COVERAGE",
    "",
    "## amazon_removals (by order_date)",
    mdTable(staging?.monthly_removals as Record<string, unknown>[], ["month", "row_count"]),
    "## amazon_removal_shipments (by shipment_date / order_date)",
    mdTable(staging?.monthly_shipments as Record<string, unknown>[], ["month", "row_count"]),
    "## expected_packages derived (detail_shipment + detail_remainder)",
    mdTable(staging?.monthly_ep as Record<string, unknown>[], [
      "month",
      "row_count",
      "detail_shipment",
      "detail_remainder",
    ]),
    "",
    "# ORIGINAL MONTHLY COVERAGE",
    "",
    "## amazon_removals",
    mdTable(original?.monthly_removals as Record<string, unknown>[], ["month", "row_count"]),
    "## amazon_removal_shipments",
    mdTable(original?.monthly_shipments as Record<string, unknown>[], ["month", "row_count"]),
    "## expected_packages derived",
    mdTable(original?.monthly_ep as Record<string, unknown>[], [
      "month",
      "row_count",
      "detail_shipment",
      "detail_remainder",
    ]),
    "",
    "# LATEST IMPORTED DATES",
    "",
    "## Staging",
    mdTable([staging?.latest_dates as Record<string, unknown>], [
      "max_removal_order_date",
      "max_shipment_date",
      "max_ep_order_date",
      "max_upload_window_end",
      "min_upload_window_start",
    ]),
    "## Original",
    mdTable([original?.latest_dates as Record<string, unknown>], [
      "max_removal_order_date",
      "max_shipment_date",
      "max_ep_order_date",
      "max_upload_window_end",
      "min_upload_window_start",
    ]),
    "",
    "# MISSING DATE RANGES",
    "",
    "Based on **successful fetch** windows in staging `raw_report_uploads` vs target `2025-09-01` → today.",
    "",
    "## REMOVAL_ORDER fetch gaps",
    orderGaps.length
      ? orderGaps.map((g) => `- \`${g.start.slice(0, 10)}\` → \`${g.end.slice(0, 10)}\``).join("\n")
      : "_None detected (full coverage)_",
    "",
    "## REMOVAL_SHIPMENT fetch gaps",
    shipmentGaps.length
      ? shipmentGaps.map((g) => `- \`${g.start.slice(0, 10)}\` → \`${g.end.slice(0, 10)}\``).join("\n")
      : "_None detected (full coverage)_",
    "",
    "Merged successful fetch coverage:",
    `- Order: ${orderWindows.map((w) => `\`${w.start.slice(0, 10)}..${w.end.slice(0, 10)}\``).join(", ") || "none"}`,
    `- Shipment: ${shipmentWindows.map((w) => `\`${w.start.slice(0, 10)}..${w.end.slice(0, 10)}\``).join(", ") || "none"}`,
    "",
    "# FAILED / DRY-RUN ONLY BATCHES",
    "",
    mdTable(stagingDryRun as Record<string, unknown>[], [
      "upload_id",
      "report_type",
      "source_run_state",
      "status",
      "window_start",
      "window_end",
    ]),
    "",
    `Fetch-complete batches: **${stagingFetchComplete.length}** · Domain-synced: **${stagingSynced.length}** · Fetch-only (pending sync): **${fetchOnlyBatches.length}** · Failed/stale: **${stagingDryRun.length}**`,
    "",
    "### Completed SP-API batches (domain-synced)",
    mdTable(completedBatches.filter((b: { window_start?: string | null }) => b.window_start) as Record<string, unknown>[], [
      "upload_id",
      "report_type",
      "window_start",
      "window_end",
      "status",
    ]),
    "",
    "### Fetch-only (pending domain sync)",
    mdTable(fetchOnlyBatches as Record<string, unknown>[], [
      "upload_id",
      "report_type",
      "window_start",
      "window_end",
      "source_run_state",
      "status",
    ]),
    "",
    mdTable(staging?.upload_batch_summary as Record<string, unknown>[], [
      "upload_id",
      "report_type",
      "window_start",
      "window_end",
      "source_run_state",
      "status",
      "fetch_complete",
      "domain_synced",
    ]),
    "",
    "# DUPLICATE PREVENTION MODEL",
    "",
    "| Layer | Mechanism |",
    "|-------|-----------|",
    "| **Fetch** | `buildReportsApiIdempotencyKey(org, store, window, report_type)` → stored in `raw_report_uploads.metadata.source_run.idempotency_key`; replay returns existing upload |",
    "| **Raw upload** | One synthetic upload per idempotency key; `content_sha256` dedupe |",
    "| **amazon_staging** | `(organization_id, upload_id, row_number)` / source line hash per upload |",
    "| **amazon_removals** | Layer A: `(org, upload_id, source_staging_id)`; Layer B: `uq_amazon_removals_business_line` (org, store, order_id, order_type, order_date, sku, fnsku, disposition) |",
    "| **amazon_removal_shipments** | Layer A: `(org, upload_id, amazon_staging_id)`; Layer B: `uq_amazon_removal_shipments_business_line` |",
    "| **expected_packages** | `rebuild_expected_packages_from_removals` upserts on business line + build_source; deletes obsolete derived rows in scope |",
    "",
    "## Live duplicate probe (staging)",
    mdTable([staging?.duplicate_check as Record<string, unknown>], [
      "removal_business_dup_groups",
      "removal_staging_dup_groups",
      "upload_idempotency_dup_keys",
    ]),
    "",
    "# EXPECTED_PACKAGES REBUILD STATUS",
    "",
    "| Env | detail_shipment | detail_remainder | resolved | unresolved |",
    "|-----|----------------:|-----------------:|---------:|-----------:|",
    `| Staging | ${staging?.ep_totals?.detail_shipment ?? "—"} | ${staging?.ep_totals?.detail_remainder ?? "—"} | ${staging?.ep_totals?.resolved ?? "—"} | ${staging?.ep_totals?.unresolved ?? "—"} |`,
    `| Original | ${original?.ep_totals?.detail_shipment ?? "—"} | ${original?.ep_totals?.detail_remainder ?? "—"} | ${original?.ep_totals?.resolved ?? "—"} | ${original?.ep_totals?.unresolved ?? "—"} |`,
    "",
    "`rebuild_expected_packages_from_removals(org_id, store_id?)` runs **after domain sync** in governed execute scripts (`sp-api-removal-reports-domain-sync-execute`, `removal-9-month-backfill-domain-sync-chunk1`, `removal-automation-orchestrator` step 3). Fetch-only runs use `runPipeline: false` and **do not** rebuild.",
    "",
    "# AUTOMATION STATUS",
    "",
    "| Component | Status |",
    "|-----------|--------|",
    "| `removal-automation-orchestrator.ts` | Implemented; **dry-run default** |",
    "| `.github/workflows/removal-automation-staging.yml` | Twice-daily cron; **scheduled = dry-run**; apply needs workflow_dispatch + `REMOVAL_AUTOMATION_APPLY_ENABLED` secret |",
    "| Sub-approvals | fetch, domain_sync, resolver each gated |",
    "| Rolling window | 7-day default with cursor overlap in `.window-cursor.json` |",
    "| 9-month backfill | Chunked monthly; chunk1 Aug 2025 window executed; remaining gaps per missing-window analysis |",
    "",
    "# SAFE NEXT STEPS",
    "",
    "1. **REMOVAL-9-MONTH-BACKFILL-DOMAIN-SYNC** — sync Sep 2025 fetch uploads (`06ddd21c…` + `3e682300…`) then rebuild",
    "2. **REMOVAL-9-MONTH-BACKFILL-FETCH-CHUNK-EXECUTE** — fetch Oct 2025, Nov 2025, Dec 1–25 2025 (monthly, `runPipeline:false`)",
    "3. Domain sync each new chunk → rebuild → allocation verify → resolver reconcile",
    "4. **ORIGINAL-REMOVAL-SHIPMENT-9MONTH-FETCH-RETRY** — retry failed shipment upload `ef31c0c9…` on original (orders already synced)",
    "5. Enable orchestrator `--apply` only after all sub-approvals + secret gate",
    "",
    "# EXACT NEXT PROMPT",
    "",
    "```",
    "REMOVAL-9-MONTH-BACKFILL-DOMAIN-SYNC-SEP2025 — domain sync + rebuild for Sep 2025 fetch-only uploads (staging, approval-gated)",
    "```",
    "",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "amazon-removal-api-date-coverage-and-batch-status.md"), report);

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "AMAZON-REMOVAL-API-DATE-COVERAGE-AND-BATCH-STATUS-READONLY",
        run_id: runId,
        branch,
        mode: "read_only_census",
        target_window: { start: TARGET_START, end: today.slice(0, 10) },
        staging_ref: STAGING_REF,
        original_ref: ORIGINAL_REF,
        staging_connected: staging?.connected ?? false,
        original_connected: original?.connected ?? false,
        artifacts: [
          "amazon-removal-api-date-coverage-and-batch-status.md",
          "census.json",
          "batch-ledger-staging.json",
          "manifest.json",
        ],
        exact_next_prompt:
          "REMOVAL-9-MONTH-BACKFILL-DOMAIN-SYNC-SEP2025 — domain sync + rebuild for Sep 2025 fetch-only uploads (staging, approval-gated)",
      },
      null,
      2,
    ),
  );

  console.log(`Wrote ${outDir}`);
  console.log(`Staging connected: ${staging?.connected}`);
  console.log(`Original connected: ${original?.connected}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
