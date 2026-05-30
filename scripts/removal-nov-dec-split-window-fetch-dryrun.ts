/**
 * REMOVAL-NOV-DEC-SPLIT-WINDOW-FETCH-DRYRUN — Amazon API probe only (no DB, no domain sync)
 *
 *   npx tsx scripts/removal-nov-dec-split-window-fetch-dryrun.ts
 *   npx tsx scripts/removal-nov-dec-split-window-fetch-dryrun.ts --window=nov_2025_w1
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createRequire, type Module } from "node:module";

import {
  SP_API_REPORT_TYPE_REMOVAL_ORDER,
  SP_API_REPORT_TYPE_REMOVAL_SHIPMENT,
} from "../lib/amazon/reports-api-source-run";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const REQUIRED_BRANCH = "feature/product-canonicalization-v3";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/removal-nov-dec-split-window-fetch-dryrun";

const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ROUNDS = 24;
const INTER_PROBE_SLEEP_MS = 2_000;

type ProbeWindow = {
  key: string;
  label: string;
  start: string;
  end: string;
};

const WINDOWS: ProbeWindow[] = [
  { key: "nov_2025_w1", label: "Nov 1–7", start: "2025-11-01T00:00:00.000Z", end: "2025-11-07T23:59:59.999Z" },
  { key: "nov_2025_w2", label: "Nov 8–14", start: "2025-11-08T00:00:00.000Z", end: "2025-11-14T23:59:59.999Z" },
  { key: "nov_2025_w3", label: "Nov 15–21", start: "2025-11-15T00:00:00.000Z", end: "2025-11-21T23:59:59.999Z" },
  { key: "nov_2025_w4", label: "Nov 22–30", start: "2025-11-22T00:00:00.000Z", end: "2025-11-30T23:59:59.999Z" },
  { key: "dec_2025_w1", label: "Dec 1–7", start: "2025-12-01T00:00:00.000Z", end: "2025-12-07T23:59:59.999Z" },
  { key: "dec_2025_w2", label: "Dec 8–14", start: "2025-12-08T00:00:00.000Z", end: "2025-12-14T23:59:59.999Z" },
  { key: "dec_2025_w3", label: "Dec 15–21", start: "2025-12-15T00:00:00.000Z", end: "2025-12-21T23:59:59.999Z" },
  { key: "dec_2025_w4", label: "Dec 22–25", start: "2025-12-22T00:00:00.000Z", end: "2025-12-25T23:59:59.999Z" },
];

type ReportKind = "order" | "shipment";

type ProbeResult = {
  window_key: string;
  window_label: string;
  report_kind: ReportKind;
  sp_report_type: string;
  data_start: string;
  data_end: string;
  create_ok: boolean;
  report_id: string | null;
  final_status: string | null;
  report_document_id: string | null;
  poll_rounds: number;
  elapsed_ms: number;
  error_code: string | null;
  error_detail: string | null;
  raw_terminal: unknown;
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

function argValue(prefix: string): string | null {
  const a = process.argv.find((x) => x.startsWith(prefix));
  return a ? a.split("=")[1]!.trim() : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function spType(kind: ReportKind): string {
  return kind === "order" ? SP_API_REPORT_TYPE_REMOVAL_ORDER : SP_API_REPORT_TYPE_REMOVAL_SHIPMENT;
}

function isTerminal(status: string): boolean {
  return status === "DONE" || status === "FATAL" || status === "CANCELLED";
}

async function probeOne(
  client: import("../lib/amazon/reports-api-client").ReportsApiClient,
  marketplaceIds: string[],
  window: ProbeWindow,
  kind: ReportKind,
): Promise<ProbeResult> {
  const t0 = Date.now();
  const base: ProbeResult = {
    window_key: window.key,
    window_label: window.label,
    report_kind: kind,
    sp_report_type: spType(kind),
    data_start: window.start,
    data_end: window.end,
    create_ok: false,
    report_id: null,
    final_status: null,
    report_document_id: null,
    poll_rounds: 0,
    elapsed_ms: 0,
    error_code: null,
    error_detail: null,
    raw_terminal: null,
  };

  try {
    const created = await client.createReport({
      reportType: spType(kind),
      marketplaceIds,
      dataStartTime: window.start,
      dataEndTime: window.end,
    });
    base.create_ok = true;
    base.report_id = created.reportId;

    for (let i = 0; i < MAX_POLL_ROUNDS; i++) {
      base.poll_rounds = i + 1;
      await sleep(POLL_INTERVAL_MS);
      const rep = await client.getReport(created.reportId);
      if (isTerminal(rep.processingStatus)) {
        base.final_status = rep.processingStatus;
        base.report_document_id = rep.reportDocumentId;
        base.raw_terminal = rep.raw;
        break;
      }
    }
    if (!base.final_status) {
      base.final_status = "TIMEOUT";
      base.error_code = "poll_timeout";
      base.error_detail = `No terminal status after ${MAX_POLL_ROUNDS} polls`;
    }
  } catch (e) {
    const err = e as { code?: string; message?: string; detail?: string; httpStatus?: number };
    base.error_code = err.code ?? "probe_error";
    base.error_detail = (err.detail ?? err.message ?? String(e)).slice(0, 400);
    base.final_status = "CREATE_FAILED";
  }

  base.elapsed_ms = Date.now() - t0;
  return base;
}

function statusEmoji(s: string | null): string {
  if (s === "DONE") return "PASS";
  if (s === "FATAL" || s === "CANCELLED" || s === "CREATE_FAILED") return "FAIL";
  if (s === "TIMEOUT") return "TIMEOUT";
  return s ?? "?";
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

  const filterKey = argValue("--window=");
  const windows = filterKey ? WINDOWS.filter((w) => w.key === filterKey) : WINDOWS;
  if (!windows.length) throw new Error(`Unknown --window=${filterKey}`);

  const { resolveReportsApiContext } = await import("../lib/amazon/reports-api-credentials");
  const { ReportsApiClient } = await import("../lib/amazon/reports-api-client");

  const ctxRes = await resolveReportsApiContext(ORG_ID, STORE_ID);
  if (!ctxRes.ok) {
    throw new Error(`Reports API context failed: ${ctxRes.error}`);
  }

  const client = new ReportsApiClient({ context: ctxRes.context });
  const marketplaceIds = ctxRes.context.marketplaceIds;

  const results: ProbeResult[] = [];
  for (const window of windows) {
    for (const kind of ["order", "shipment"] as const) {
      console.log(`\n>>> probe ${window.key} ${kind} ...`);
      const r = await probeOne(client, marketplaceIds, window, kind);
      results.push(r);
      console.log(
        JSON.stringify({
          window: window.key,
          kind,
          status: r.final_status,
          report_id: r.report_id,
        }),
      );
      await sleep(INTER_PROBE_SLEEP_MS);
    }
  }

  const passing = results.filter((r) => r.final_status === "DONE");
  const allFatal =
    results.length > 0 &&
    results.every((r) => r.final_status === "FATAL" || r.final_status === "CANCELLED");

  const splitHelps = passing.length > 0;

  let exactNextPrompt: string;
  if (splitHelps) {
    const passKeys = [...new Set(passing.map((r) => r.window_key))];
    exactNextPrompt = `REMOVAL-NOV-DEC-PASSING-WINDOWS-FETCH-SYNC — fetch+domain-sync nov_2025_w1 only (2025-11-01→2025-11-07); REMOVAL-NOV-DEC-ORIGINAL-PARITY-IMPORT-PLAN for 2025-11-08→2025-12-25; retry dec_2025_w4 probe after quota cooldown`;
  } else if (allFatal) {
    exactNextPrompt =
      "REMOVAL-NOV-DEC-ORIGINAL-PARITY-IMPORT-PLAN — all weekly probes FATAL; plan import from original DB/CSV for 2025-11-01 → 2025-12-25";
  } else {
    exactNextPrompt =
      "REMOVAL-NOV-DEC-SPLIT-WINDOW-FETCH-DRYRUN-RETRY — mixed/timeout results; retry failed windows or escalate to original parity import";
  }

  const perWindow = windows.map((w) => {
    const order = results.find((r) => r.window_key === w.key && r.report_kind === "order");
    const shipment = results.find((r) => r.window_key === w.key && r.report_kind === "shipment");
    return { window: w, order, shipment };
  });

  const report = [
    "# REMOVAL-NOV-DEC-SPLIT-WINDOW-FETCH-DRYRUN",
    "",
    `Run: \`${runId}\` · Branch: \`${branch}\` · Mode: Amazon API probe only · Target: staging \`${STAGING_REF}\``,
    "",
    "**No DB writes. No domain sync. No rebuild. No resolver.**",
    "",
    "## Per-window status",
    "",
    "| Window | Order | Shipment | Order report_id | Shipment report_id |",
    "|--------|-------|----------|-----------------|-------------------|",
    ...perWindow.map(({ window, order, shipment }) => {
      return `| **${window.label}** (\`${window.key}\`) | ${statusEmoji(order?.final_status ?? null)} \`${order?.final_status ?? "—"}\` | ${statusEmoji(shipment?.final_status ?? null)} \`${shipment?.final_status ?? "—"}\` | \`${order?.report_id ?? "—"}\` | \`${shipment?.report_id ?? "—"}\` |`;
    }),
    "",
    "## Summary",
    "",
    `| Metric | Value |`,
    `|--------|------:|`,
    `| Windows probed | ${windows.length} |`,
    `| Report requests (order+shipment) | ${results.length} |`,
    `| DONE (pass) | ${results.filter((r) => r.final_status === "DONE").length} |`,
    `| FATAL | ${results.filter((r) => r.final_status === "FATAL").length} |`,
    `| CANCELLED | ${results.filter((r) => r.final_status === "CANCELLED").length} |`,
    `| CREATE_FAILED / TIMEOUT | ${results.filter((r) => r.final_status === "CREATE_FAILED" || r.final_status === "TIMEOUT").length} |`,
    `| **Split window helps?** | **${splitHelps ? "YES — at least one weekly slice DONE" : allFatal ? "NO — all FATAL/CANCELLED" : "INCONCLUSIVE"}** |`,
    "",
    "## Amazon error evidence",
    "",
    "Terminal `getReport` payloads (FATAL/CANCELLED/DONE):",
    "",
    "```json",
    JSON.stringify(
      results.map((r) => ({
        window: r.window_key,
        kind: r.report_kind,
        report_id: r.report_id,
        final_status: r.final_status,
        report_document_id: r.report_document_id,
        error_code: r.error_code,
        error_detail: r.error_detail,
        raw: r.raw_terminal,
      })),
      null,
      2,
    ),
    "```",
    "",
    splitHelps
      ? [
          "## Passing windows — fetch/sync plan",
          "",
          ...passing.map(
            (p) =>
              `- **${p.window_label}** (\`${p.window_key}\`) **${p.report_kind}**: report_id=\`${p.report_id}\`, window \`${p.data_start}\` → \`${p.data_end}\``,
          ),
          "",
          "**Next (separate approval):** run `sp-api-removal-reports-fetch-execute.ts --backfill-9month` per passing window only, then `sp-api-removal-reports-domain-sync-execute.ts --apply`.",
        ].join("\n")
      : allFatal
        ? [
            "## Fallback recommendation",
            "",
            "All weekly probes returned FATAL/CANCELLED. Monthly FATAL is not bypassed by splitting.",
            "",
            "Recommend: **REMOVAL-NOV-DEC-ORIGINAL-PARITY-IMPORT-PLAN** from original DB (`kxsvedvpjldygtdbylsy`) — Nov 99 removals / 862 shipments; Dec 531 removals / 930 shipments.",
          ].join("\n")
        : "",
    "",
    "## EXACT_NEXT_PROMPT",
    "",
    "```",
    exactNextPrompt,
    "```",
    "",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "REMOVAL-NOV-DEC-SPLIT-WINDOW-FETCH-DRYRUN.md"), report);
  fs.writeFileSync(path.join(outDir, "probe-results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "REMOVAL-NOV-DEC-SPLIT-WINDOW-FETCH-DRYRUN",
        run_id: runId,
        branch,
        staging_ref: STAGING_REF,
        windows_probed: windows.map((w) => w.key),
        split_helps: splitHelps,
        all_fatal: allFatal,
        done_count: results.filter((r) => r.final_status === "DONE").length,
        fatal_count: results.filter((r) => r.final_status === "FATAL").length,
        passing_windows: [...new Set(passing.map((r) => r.window_key))],
        exact_next_prompt: exactNextPrompt,
        no_db_writes: true,
        no_domain_sync: true,
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
        split_helps: splitHelps,
        all_fatal: allFatal,
        done: results.filter((r) => r.final_status === "DONE").length,
        fatal: results.filter((r) => r.final_status === "FATAL").length,
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
