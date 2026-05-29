/**
 * REMOVAL 9-MONTH BACKFILL NEXT WINDOWS PLAN (read-only)
 *
 *   npx tsx scripts/removal-9-month-backfill-next-windows-plan.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { loadEnvLocalIntoProcess, supabaseUrlMatchesStagingRef } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const OUT_BASE = ".cursor/audit-reports/removal-9-month-backfill-next-windows-plan";
const APPROVAL_FETCH = ".cursor/operator-approvals/removal-9-month-backfill-fetch-approval.md";
const APPROVAL_DOMAIN = ".cursor/operator-approvals/sp-api-removal-reports-domain-sync-approval.md";

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

const SP_ORDER = "GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA";
const SP_SHIPMENT = "GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA";

/** Chunk 1 execute (documented). */
const CHUNK1 = { start: "2025-08-27T00:00:00.000Z", end: "2025-08-31T23:59:59.999Z", label: "chunk1" };
/** Prior bulk SP-API window. */
const KNOWN_BULK = { start: "2025-12-26T00:00:00.000Z", end: "2026-04-21T00:00:00.000Z", label: "bulk_20260527" };

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

function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function parseDay(s: string): Date {
  return utcDayStart(new Date(s));
}

function isoEndOfDay(d: Date): string {
  const e = new Date(d);
  e.setUTCHours(23, 59, 59, 999);
  return e.toISOString();
}

function isoStartOfDay(d: Date): string {
  return utcDayStart(d).toISOString();
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  if (!intervals.length) return [];
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

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
  const today = utcDayStart(new Date());
  const backfillStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 9, today.getUTCDate()));
  const target: Interval = {
    start: backfillStart,
    end: today,
    label: "target_9mo",
  };

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  let windows: Array<Record<string, unknown>> = [];
  const blockers: string[] = [];

  if (!dbUrl || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    blockers.push("STAGING_DIRECT_POSTGRES_URL missing or wrong ref");
  } else {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    const r = await client.query(
      `SELECT
         u.id::text AS upload_id,
         u.report_type,
         u.status,
         u.created_at::text,
         COALESCE(u.metadata->'source_run'->>'report_type', '') AS sp_report_type,
         u.metadata->'source_run'->>'state' AS source_run_state,
         u.metadata->'source_run'->'window'->>'start' AS window_start,
         u.metadata->'source_run'->'window'->>'end' AS window_end,
         (u.metadata->>'content_sha256' IS NOT NULL) AS has_sha
       FROM public.raw_report_uploads u
       WHERE u.organization_id = $1::uuid
         AND u.report_type IN ('REMOVAL_ORDER', 'REMOVAL_SHIPMENT')
       ORDER BY u.created_at DESC`,
      [ORG_ID],
    );
    windows = r.rows as Array<Record<string, unknown>>;
    await client.end();
  }

  const successful = windows.filter((w) => {
    const state = String(w.source_run_state ?? "");
    const hasSha = Boolean(w.has_sha);
    return hasSha && state !== "failed" && w.window_start && w.window_end;
  });

  const toInterval = (w: Record<string, unknown>): Interval => ({
    start: parseDay(String(w.window_start)),
    end: parseDay(String(w.window_end)),
    label: String(w.upload_id),
  });

  const orderCov = mergeIntervals(
    successful
      .filter(
        (w) =>
          String(w.sp_report_type) === SP_ORDER || String(w.report_type) === "REMOVAL_ORDER",
      )
      .map(toInterval),
  );
  const shipCov = mergeIntervals(
    successful
      .filter(
        (w) =>
          String(w.sp_report_type) === SP_SHIPMENT || String(w.report_type) === "REMOVAL_SHIPMENT",
      )
      .map(toInterval),
  );

  // Union: both report types must cover a day for "full" coverage; fetch plan uses conservative union gaps
  const unionCov = mergeIntervals([...orderCov, ...shipCov]);

  const orderGaps = subtractCoverage(target, orderCov);
  const shipGaps = subtractCoverage(target, shipCov);
  const unionGaps = subtractCoverage(target, unionCov);

  // Exclude chunk 1 from remaining if present in DB
  const chunk1Cov: Interval[] = [
    { start: parseDay(CHUNK1.start), end: parseDay(CHUNK1.end), label: CHUNK1.label },
  ];

  const remainingGaps = subtractCoverage(
    { start: target.start, end: target.end, label: "target" },
    mergeIntervals([...unionCov, ...chunk1Cov]),
  );

  const fetchChunks: Array<{
    chunk_index: number;
    window_start: string;
    window_end: string;
    reports: string[];
    api_report_creates: number;
    execute_prompt: string;
  }> = [];

  let idx = 2; // chunk 1 (2025-08-27..08-31) already executed
  for (const gap of remainingGaps) {
    for (const mc of monthChunks(gap.start, gap.end)) {
      fetchChunks.push({
        chunk_index: idx,
        window_start: isoStartOfDay(mc.start),
        window_end: isoEndOfDay(mc.end),
        reports: [SP_ORDER, SP_SHIPMENT],
        api_report_creates: 2,
        execute_prompt: `REMOVAL-9-MONTH-BACKFILL-FETCH-CHUNK${idx}`,
      });
      idx += 1;
    }
  }

  const gapSep2025 = {
    start: "2025-09-01T00:00:00.000Z",
    end: "2025-12-25T23:59:59.999Z",
    note: "Before KNOWN_BULK 2025-12-26; includes Sep–Dec 2025",
  };
  const gapApr2026 = {
    start: "2026-04-22T00:00:00.000Z",
    end: isoEndOfDay(today),
    note: "After KNOWN_BULK 2026-04-21 through today",
  };

  const estimatedApiCalls = fetchChunks.reduce((s, c) => s + c.api_report_creates, 0);

  fs.writeFileSync(
    path.join(outDir, "existing-report-windows.json"),
    JSON.stringify(
      {
        staging_ref: STAGING_REF,
        inventory_count: windows.length,
        successful_count: successful.length,
        chunk1_documented: CHUNK1,
        known_bulk: KNOWN_BULK,
        merged_coverage: {
          removal_order: orderCov.map((c) => ({ start: c.start.toISOString(), end: c.end.toISOString() })),
          removal_shipment: shipCov.map((c) => ({ start: c.start.toISOString(), end: c.end.toISOString() })),
          union: unionCov.map((c) => ({ start: c.start.toISOString(), end: c.end.toISOString() })),
        },
        windows: successful,
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "gap-windows.md"),
    [
      "# Gap windows (after chunk 1)",
      "",
      `**Target 9-month:** \`${target.start.toISOString().slice(0, 10)}\` → \`${target.end.toISOString().slice(0, 10)}\` (today UTC)`,
      "",
      "## Documented coverage",
      "",
      "| Window | Source |",
      "|--------|--------|",
      `| ${CHUNK1.start.slice(0, 10)} → ${CHUNK1.end.slice(0, 10)} | Chunk 1 fetch execute |`,
      `| ${KNOWN_BULK.start.slice(0, 10)} → ${KNOWN_BULK.end.slice(0, 10)} | Prior SP-API bulk fetch |`,
      "",
      "## Operator-expected gaps",
      "",
      "| Gap | Range | Status in plan |",
      "|-----|-------|----------------|",
      `| Pre-bulk | ${gapSep2025.start.slice(0, 10)} → ${gapSep2025.end.slice(0, 10)} | ${remainingGaps.some((g) => g.start <= parseDay(gapSep2025.end) && g.end >= parseDay(gapSep2025.start)) ? "in remaining chunks" : "verify DB overlap"} |`,
      `| Post-bulk | ${gapApr2026.start.slice(0, 10)} → ${gapApr2026.end.slice(0, 10)} | ${remainingGaps.some((g) => g.start <= today && g.end >= parseDay(gapApr2026.start)) ? "in remaining chunks" : "verify"} |`,
      "",
      "## DB-derived gaps (union ORDER ∪ SHIPMENT coverage subtracted)",
      "",
      `| Metric | Count |`,
      `|--------|------:|`,
      `| ORDER-only gap intervals | ${orderGaps.length} |`,
      `| SHIPMENT-only gap intervals | ${shipGaps.length} |`,
      `| Union gap intervals (fetch plan) | ${unionGaps.length} |`,
      `| **Remaining after chunk1** | **${remainingGaps.length}** |`,
      "",
      ...(remainingGaps.length
        ? remainingGaps.map((g) => `- \`${g.label}\``)
        : ["- None"]),
      "",
      "## Internal micro-gaps",
      "",
      "If ORDER and SHIPMENT coverage differ within the bulk window, re-fetch the smaller gap only.",
      orderGaps.length !== shipGaps.length
        ? `- ORDER vs SHIPMENT gap count mismatch: ${orderGaps.length} vs ${shipGaps.length}`
        : "- No ORDER/SHIPMENT gap count mismatch detected",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "chunked-fetch-plan.json"),
    JSON.stringify(
      {
        remaining_gap_intervals: remainingGaps.length,
        monthly_execute_chunks: fetchChunks.length,
        estimated_api_report_creates: estimatedApiCalls,
        max_chunks_per_session: 2,
        estimated_sessions: Math.ceil(fetchChunks.length / 2),
        chunks: fetchChunks,
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "execute-prompts.md"),
    [
      "# Executable prompts (approval-gated)",
      "",
      "## Fetch (per chunk)",
      "",
      "```text",
      "APPROVAL: removal-9-month-backfill-fetch-approval.md",
      "APPROVED_TO_RUN_STAGING=true",
      "APPROVED_REMOVAL_9_MONTH_BACKFILL_FETCH=true",
      "",
      "REMOVAL-9-MONTH-BACKFILL-FETCH-CHUNK{N}",
      "npx tsx scripts/sp-api-removal-reports-fetch-execute.ts --backfill-9month \\",
      "  --window-start=<ISO> --window-end=<ISO>",
      "```",
      "",
      "## Domain sync (after each fetch batch — separate approval)",
      "",
      "```text",
      "APPROVAL: sp-api-removal-reports-domain-sync-approval.md",
      "REMOVAL-9-MONTH-BACKFILL-DOMAIN-SYNC-CHUNK{N}",
      "npx tsx scripts/sp-api-removal-reports-domain-sync-execute.ts --apply \\",
      "  --order-upload-id=<uuid> --shipment-upload-id=<uuid>",
      "```",
      "",
      "## Loop-run order (recommended)",
      "",
      ...fetchChunks.slice(0, 12).map(
        (c) =>
          `${c.chunk_index}. **${c.execute_prompt}** — \`${c.window_start.slice(0, 10)}\` → \`${c.window_end.slice(0, 10)}\` (2 API creates)`,
      ),
      fetchChunks.length > 12 ? `\n... +${fetchChunks.length - 12} more chunks in chunked-fetch-plan.json` : "",
      "",
      "## Incremental (post-backfill)",
      "",
      "- Twice-daily: rolling 7-day window, same two report types",
      "- Weekly: re-run this plan script; document any new gaps",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "approval-gates.md"),
    [
      "# Approval gates",
      "",
      `| Step | File | Flags |`,
      `|------|------|-------|`,
      `| Fetch | \`${APPROVAL_FETCH}\` | APPROVED_TO_RUN_STAGING, APPROVED_REMOVAL_9_MONTH_BACKFILL_FETCH |`,
      `| Domain sync | \`${APPROVAL_DOMAIN}\` | APPROVED_TO_RUN_STAGING, APPROVED_SP_API_REMOVAL_REPORTS_DOMAIN_SYNC |`,
      "",
      "Never fetch + domain sync in one unattended run without both approvals.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.length ? blockers.map((b) => `- ${b}`).join("\n") + "\n" : "- None\n");

  const nextChunk = fetchChunks[0];
  const nextPrompt = nextChunk
    ? `${nextChunk.execute_prompt} — window ${nextChunk.window_start.slice(0, 10)}..${nextChunk.window_end.slice(0, 10)} fetch only (approval-gated)`
    : "REMOVAL-9-MONTH-BACKFILL-COMPLETE — schedule twice-daily incremental + weekly gap scan";

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt_id: "REMOVAL-9-MONTH-BACKFILL-NEXT-WINDOWS-PLAN",
        run_id: runId,
        branch,
        mode: "read_only",
        db_mutated: false,
        amazon_api_called: false,
        target_window: { start: target.start.toISOString(), end: target.end.toISOString() },
        chunk1: CHUNK1,
        known_bulk: KNOWN_BULK,
        remaining_gap_intervals: remainingGaps.length,
        monthly_execute_chunks: fetchChunks.length,
        estimated_api_report_creates: estimatedApiCalls,
        gap_sep_2025: gapSep2025,
        gap_apr_2026: gapApr2026,
        exact_next_prompt: nextPrompt,
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
        remaining_gap_intervals: remainingGaps.length,
        monthly_chunks: fetchChunks.length,
        estimated_api_calls: estimatedApiCalls,
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
