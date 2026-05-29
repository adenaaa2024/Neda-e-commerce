/**
 * REMOVAL 9-MONTH BACKFILL PLAN (read-only)
 *
 *   npx tsx scripts/removal-9-month-backfill-plan.ts --run-id=<UTC_Z>
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
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const OUT_BASE = ".cursor/audit-reports/removal-9-month-backfill-plan";
const APPROVAL_PATH = ".cursor/operator-approvals/removal-9-month-backfill-fetch-approval.md";

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

const SP_ORDER = "GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA";
const SP_SHIPMENT = "GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA";

const KNOWN_FETCHED_START = "2025-12-26T00:00:00.000Z";
const KNOWN_FETCHED_END = "2026-04-21T00:00:00.000Z";

type ReportWindow = {
  upload_id: string;
  report_type: string;
  sp_report_type: string;
  status: string;
  source_run_state: string | null;
  window_start: string;
  window_end: string;
  content_sha256: boolean;
  created_at: string;
  importable: boolean;
};

type Interval = { start: Date; end: Date; label: string };

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function writeApproval(): void {
  fs.writeFileSync(
    path.join(process.cwd(), APPROVAL_PATH),
    `# Removal 9-month backfill fetch (staging)

**Default:** not approved.

| Field | Value |
|-------|--------|
| Staging ref | \`${STAGING_REF}\` |
| Production / original | forbidden |

\`\`\`text
APPROVED_TO_RUN_STAGING=false
APPROVED_REMOVAL_9_MONTH_BACKFILL_FETCH=false
\`\`\`

## Scope

- SP-API fetch only: \`GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA\` + \`GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA\`
- Chunked monthly windows; synthetic \`raw_report_uploads\` only per chunk (\`runPipeline: false\`)
- Domain sync / rebuild under separate approval per chunk batch
- No \`products.insert\` / no \`product_identifier_map.insert\`

## Sign-off

\`\`\`
APPROVED_TO_RUN_STAGING=false
APPROVED_REMOVAL_9_MONTH_BACKFILL_FETCH=false
Approved by:
UTC date:
Max chunks per execute session (default 2):
\`\`\`
`,
  );
}

function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addMonthsUtc(d: Date, months: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate()));
}

function isoDay(d: Date): string {
  return d.toISOString();
}

function parseDay(s: string): Date {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`bad date: ${s}`);
  return utcDayStart(d);
}

function monthChunks(start: Date, end: Date): Interval[] {
  const out: Interval[] = [];
  let cur = utcDayStart(start);
  const endDay = utcDayStart(end);
  while (cur <= endDay) {
    const monthEnd = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 0));
    const chunkEnd = monthEnd < endDay ? monthEnd : endDay;
    out.push({
      start: cur,
      end: chunkEnd,
      label: `${cur.toISOString().slice(0, 10)}..${chunkEnd.toISOString().slice(0, 10)}`,
    });
    cur = new Date(Date.UTC(chunkEnd.getUTCFullYear(), chunkEnd.getUTCMonth(), chunkEnd.getUTCDate() + 1));
  }
  return out;
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: Interval[] = [{ ...sorted[0]! }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const last = merged[merged.length - 1]!;
    if (cur.start.getTime() <= last.end.getTime() + 86400000) {
      if (cur.end > last.end) last.end = cur.end;
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

function subtractCoverage(target: Interval, covered: Interval[]): Interval[] {
  let gaps: Interval[] = [target];
  for (const c of covered) {
    const next: Interval[] = [];
    for (const g of gaps) {
      if (c.end < g.start || c.start > g.end) {
        next.push(g);
        continue;
      }
      if (c.start > g.start) {
        next.push({
          start: g.start,
          end: new Date(c.start.getTime() - 86400000),
          label: "",
        });
      }
      if (c.end < g.end) {
        next.push({
          start: new Date(c.end.getTime() + 86400000),
          end: g.end,
          label: "",
        });
      }
    }
    gaps = next.filter((x) => x.start <= x.end);
  }
  return gaps.map((g) => ({
    ...g,
    label: `${g.start.toISOString().slice(0, 10)}..${g.end.toISOString().slice(0, 10)}`,
  }));
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  writeApproval();

  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  let branch = "unknown";
  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
  } catch {
    /* ignore */
  }

  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}.`);

  const today = utcDayStart(new Date());
  const backfillStart = addMonthsUtc(today, -9);
  const targetWindow: Interval = {
    start: backfillStart,
    end: today,
    label: `${backfillStart.toISOString().slice(0, 10)}..${today.toISOString().slice(0, 10)}`,
  };

  let existingWindows: ReportWindow[] = [];
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    blockers.push("STAGING_DIRECT_POSTGRES_URL unset or wrong ref — inventory skipped.");
  } else {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query("SET statement_timeout = '120s'");
    const r = await client.query(
      `SELECT
         u.id::text,
         u.report_type,
         u.status,
         u.created_at::text,
         COALESCE(u.metadata->'source_run'->>'report_type', u.metadata->'source_run'->>'reportType') AS sp_report_type,
         u.metadata->'source_run'->>'state' AS source_run_state,
         u.metadata->'source_run'->'window'->>'start' AS window_start,
         u.metadata->'source_run'->'window'->>'end' AS window_end,
         (u.metadata->>'content_sha256' IS NOT NULL AND btrim(u.metadata->>'content_sha256') <> '') AS has_sha
       FROM public.raw_report_uploads u
       WHERE u.organization_id = $1::uuid
         AND u.report_type IN ('REMOVAL_ORDER', 'REMOVAL_SHIPMENT')
       ORDER BY u.created_at DESC`,
      [ORG_ID],
    );
    existingWindows = (r.rows as Record<string, unknown>[])
      .map((row) => {
        const ws = row.window_start != null ? String(row.window_start) : "";
        const we = row.window_end != null ? String(row.window_end) : "";
        const hasSha = Boolean(row.has_sha);
        const state = row.source_run_state != null ? String(row.source_run_state) : null;
        const status = String(row.status ?? "");
        const importable =
          hasSha &&
          (state === "synthetic_upload_ready" || state === "complete" || status === "mapped" || status === "synced");
        return {
          upload_id: String(row.id),
          report_type: String(row.report_type),
          sp_report_type: String(row.sp_report_type ?? ""),
          status,
          source_run_state: state,
          window_start: ws,
          window_end: we,
          content_sha256: hasSha,
          created_at: String(row.created_at),
          importable,
        };
      })
      .filter((w) => w.window_start && w.window_end);
    await client.end();
  }

  const successful = existingWindows.filter(
    (w) => w.importable && w.source_run_state !== "failed",
  );

  const orderCoverage = mergeIntervals(
    successful
      .filter((w) => w.sp_report_type === SP_ORDER || w.report_type === "REMOVAL_ORDER")
      .map((w) => ({
        start: parseDay(w.window_start),
        end: parseDay(w.window_end),
        label: w.upload_id,
      })),
  );

  const shipmentCoverage = mergeIntervals(
    successful
      .filter((w) => w.sp_report_type === SP_SHIPMENT || w.report_type === "REMOVAL_SHIPMENT")
      .map((w) => ({
        start: parseDay(w.window_start),
        end: parseDay(w.window_end),
        label: w.upload_id,
      })),
  );

  const orderGaps = subtractCoverage(targetWindow, orderCoverage);
  const shipmentGaps = subtractCoverage(targetWindow, shipmentCoverage);

  const conservativeGaps = mergeIntervals([...orderGaps, ...shipmentGaps]);

  const fetchChunks: Array<{
    chunk_index: number;
    window_start: string;
    window_end: string;
    reports: string[];
    api_calls: number;
    idempotency_note: string;
  }> = [];

  let chunkIdx = 0;
  for (const gap of conservativeGaps) {
    for (const mc of monthChunks(gap.start, gap.end)) {
      chunkIdx += 1;
      fetchChunks.push({
        chunk_index: chunkIdx,
        window_start: isoDay(mc.start),
        window_end: isoDay(new Date(mc.end.getTime() + 86399999)),
        reports: [SP_ORDER, SP_SHIPMENT],
        api_calls: 2,
        idempotency_note: `buildRemovalOrderIdempotencyKey + buildRemovalShipmentIdempotencyKey(org, store, window) — replay-safe`,
      });
    }
  }

  const proposedApiCalls = fetchChunks.reduce((s, c) => s + c.api_calls, 0);

  const gapAnalysis = {
    today_utc: today.toISOString(),
    backfill_start_utc: backfillStart.toISOString(),
    target_window: {
      start: targetWindow.start.toISOString(),
      end: targetWindow.end.toISOString(),
    },
    known_fetched_window: { start: KNOWN_FETCHED_START, end: KNOWN_FETCHED_END },
    gap_before_known: {
      start: targetWindow.start.toISOString(),
      end: new Date(parseDay(KNOWN_FETCHED_START).getTime() - 86400000).toISOString(),
    },
    gap_after_known: {
      start: new Date(parseDay(KNOWN_FETCHED_END).getTime() + 86400000).toISOString(),
      end: targetWindow.end.toISOString(),
    },
    order_gaps: orderGaps.map((g) => ({ start: g.start.toISOString(), end: g.end.toISOString(), label: g.label })),
    shipment_gaps: shipmentGaps.map((g) => ({ start: g.start.toISOString(), end: g.end.toISOString(), label: g.label })),
    conservative_union_gaps: conservativeGaps.map((g) => ({
      start: g.start.toISOString(),
      end: g.end.toISOString(),
      label: g.label,
    })),
  };

  fs.writeFileSync(
    path.join(outDir, "existing-report-windows.json"),
    JSON.stringify(
      {
        staging_ref: STAGING_REF,
        organization_id: ORG_ID,
        store_id: STORE_ID,
        inventory_count: existingWindows.length,
        successful_count: successful.length,
        windows: existingWindows,
        merged_coverage: {
          removal_order: orderCoverage.map((c) => ({
            start: c.start.toISOString(),
            end: c.end.toISOString(),
          })),
          removal_shipment: shipmentCoverage.map((c) => ({
            start: c.start.toISOString(),
            end: c.end.toISOString(),
          })),
        },
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "missing-window-fetch-plan.json"),
    JSON.stringify(
      {
        missing_windows_count: conservativeGaps.length,
        monthly_chunks: fetchChunks.length,
        proposed_api_calls: proposedApiCalls,
        gaps: gapAnalysis,
        chunks: fetchChunks,
        incremental_after_backfill: {
          cadence: "twice_daily",
          window: "rolling_7_day",
          note: "Each incremental run fetches last 7 days with idempotency; domain sync optional separate approval",
        },
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "backfill-window-analysis.md"),
    [
      "# Backfill window analysis",
      "",
      `**Runtime today (UTC):** \`${today.toISOString()}\``,
      "",
      "## Target 9-month window",
      "",
      `| Field | Value |`,
      `|-------|-------|`,
      `| Start (9 months ago) | \`${backfillStart.toISOString()}\` |`,
      `| End (today) | \`${today.toISOString()}\` |`,
      "",
      "## Known fetched window (SP-API execute 20260527T202818Z)",
      "",
      `- **${KNOWN_FETCHED_START}** → **${KNOWN_FETCHED_END}**`,
      "- Order rows: 1,649 · Shipment rows: 5,305",
      "",
      "## Gap identification",
      "",
      "### Before known window",
      "",
      `- \`${gapAnalysis.gap_before_known.start}\` → \`${gapAnalysis.gap_before_known.end}\``,
      "",
      "### After known window → today",
      "",
      `- \`${gapAnalysis.gap_after_known.start}\` → \`${gapAnalysis.gap_after_known.end}\``,
      "",
      "### Internal gaps (DB metadata merge)",
      "",
      `- REMOVAL_ORDER uncovered intervals: **${orderGaps.length}**`,
      `- REMOVAL_SHIPMENT uncovered intervals: **${shipmentGaps.length}**`,
      `- Conservative union gaps to fetch: **${conservativeGaps.length}**`,
      "",
      conservativeGaps.length
        ? conservativeGaps.map((g) => `- \`${g.label}\``).join("\n")
        : "- None if full 9-month coverage already present for both report types",
      "",
      "## Domain sync note",
      "",
      "Fetch-only chunks use `runPipeline: false`. Overlap with legacy CSV domain (1629/4934 pre-SP-API) is expected;",
      "domain sync must use business-key upsert + cross-upload shipment skip to avoid duplicates.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "chunked-fetch-plan.md"),
    [
      "# Chunked fetch plan",
      "",
      "## Strategy",
      "",
      "| Rule | Value |",
      "|------|-------|",
      "| Chunk size | **Calendar month** (UTC) |",
      "| Order per chunk | REMOVAL_ORDER fetch → REMOVAL_SHIPMENT fetch |",
      "| Throttle | 5s between resume polls; max 120 resume rounds (existing worker) |",
      "| Idempotency | Per (org, store, report_type, window) via `buildRemoval*IdempotencyKey` |",
      "| Execute gate | `APPROVED_REMOVAL_9_MONTH_BACKFILL_FETCH=true` + staging ref |",
      "| Domain | **Fetch only** — sync/rebuild separate approval per batch |",
      "",
      "## Proposed chunks",
      "",
      `| # | window_start | window_end | API calls |`,
      `|---|--------------|------------|-----------|`,
      ...fetchChunks.map(
        (c) =>
          `| ${c.chunk_index} | \`${c.window_start.slice(0, 10)}\` | \`${c.window_end.slice(0, 10)}\` | ${c.api_calls} |`,
      ),
      "",
      `**Total monthly chunks:** ${fetchChunks.length} · **Total API report creates:** ${proposedApiCalls}`,
      "",
      "## Execute batching (operator)",
      "",
      "- Run **2 chunks per session** (4 report requests) to respect SP-API rate limits",
      "- Script: extend `sp-api-removal-reports-fetch-execute.ts` with `--window-start` / `--window-end` per chunk",
      "- On FATAL: diagnose via `sp-api-removal-reports-fetch-retry-diagnostic.ts`; do not domain-sync failed placeholders",
      "",
      "## Post-backfill incremental",
      "",
      "| Cadence | Window | Reports |",
      "|---------|--------|---------|",
      "| Twice daily (cron) | Rolling last **7 days** | Order + Shipment |",
      "| Weekly reconcile | Full 9-month gap scan (this plan script) | Re-fetch missing intervals only |",
      "",
      "Incremental fetch → synthetic upload only; optional auto-sync behind separate approval flag.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "approval-file.md"),
    [
      "# Approval file",
      "",
      `Path: \`${APPROVAL_PATH}\``,
      "",
      "```text",
      "APPROVED_TO_RUN_STAGING=false",
      "APPROVED_REMOVAL_9_MONTH_BACKFILL_FETCH=false",
      "```",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length ? blockers.map((b) => `- ${b}`).join("\n") + "\n" : "- None\n",
  );

  const nextPrompt =
    conservativeGaps.length > 0
      ? "REMOVAL-9-MONTH-BACKFILL-FETCH-EXECUTE — fetch chunk 1 (oldest missing month): order + shipment synthetic uploads only (approval-gated)"
      : "REMOVAL-9-MONTH-INCREMENTAL-FETCH-PLAN — backfill coverage complete; schedule twice-daily rolling 7-day fetch";

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "REMOVAL-9-MONTH-BACKFILL-PLAN",
        run_id: runId,
        branch,
        staging_ref: STAGING_REF,
        today_utc: today.toISOString(),
        target_window: gapAnalysis.target_window,
        missing_windows_count: conservativeGaps.length,
        monthly_chunks: fetchChunks.length,
        proposed_api_calls: proposedApiCalls,
        approval_file: APPROVAL_PATH,
        exact_next_prompt: nextPrompt,
        forbidden: { amazon_api: true, db_writes: true },
        status: blockers.length ? "BLOCKED" : "PASS",
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: blockers.length === 0,
        outDir: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
        missing_windows_count: conservativeGaps.length,
        monthly_chunks: fetchChunks.length,
        proposed_api_calls: proposedApiCalls,
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
