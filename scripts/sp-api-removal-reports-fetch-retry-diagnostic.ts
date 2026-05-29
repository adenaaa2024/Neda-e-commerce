/**
 * SP-API REMOVAL REPORTS FETCH RETRY DIAGNOSTIC (read-only; optional --probe)
 *
 *   npx tsx scripts/sp-api-removal-reports-fetch-retry-diagnostic.ts
 *   npx tsx scripts/sp-api-removal-reports-fetch-retry-diagnostic.ts --probe
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createRequire, type Module } from "node:module";
import pg from "pg";

import {
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const FETCH_BASE = ".cursor/audit-reports/sp-api-removal-reports-fetch-execute";
const OUT_BASE = ".cursor/audit-reports/sp-api-removal-reports-fetch-retry-diagnostic";

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

const SP_ORDER = "GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA";
const SP_SHIPMENT = "GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA";

type FetchRunRef = {
  run_id: string;
  order: Record<string, string>;
  shipment: Record<string, string>;
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

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function parseMdTable(md: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of md.split("\n")) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*`?([^`|]+)`?\s*\|/);
    if (!m || m[1]!.includes("---") || m[1] === "Field") continue;
    out[m[1]!.trim()] = m[2]!.trim().replace(/\*\*/g, "");
  }
  return out;
}

function collectFetchRuns(): FetchRunRef[] {
  const base = path.join(process.cwd(), FETCH_BASE);
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse()
    .slice(0, 5)
    .map((run_id) => {
      const dir = path.join(base, run_id);
      const orderPath = path.join(dir, "fetch-result-removal-order.md");
      const shipPath = path.join(dir, "fetch-result-removal-shipment.md");
      return {
        run_id,
        order: fs.existsSync(orderPath) ? parseMdTable(fs.readFileSync(orderPath, "utf8")) : {},
        shipment: fs.existsSync(shipPath) ? parseMdTable(fs.readFileSync(shipPath, "utf8")) : {},
      };
    });
}

function envPresent(name: string): boolean {
  const v = process.env[name]?.trim();
  return !!v;
}

function redactUrl(url: string): string {
  return url.replace(/https:\/\/([a-z]{20})\.supabase\.co.*/, "https://$1.supabase.co/…");
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const probe = hasFlag("--probe");
  const retryRun = hasFlag("--retry-run");

  let branch = "unknown";
  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
  } catch {
    /* ignore */
  }

  const fetchRuns = collectFetchRuns();
  const latest = fetchRuns[0];

  const orderReportId = latest?.order.report_id ?? "";
  const shipReportId = latest?.shipment.report_id ?? "";
  const orderUploadId = latest?.order.upload_id ?? "";
  const shipUploadId = latest?.shipment.upload_id ?? "";

  const envAudit = {
    ENABLE_AMAZON_REPORTS_API_WORKER: envPresent("ENABLE_AMAZON_REPORTS_API_WORKER"),
    ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER: envPresent("ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER"),
    ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT: envPresent("ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT"),
    SUPABASE_URL: envPresent("SUPABASE_URL") || envPresent("NEXT_PUBLIC_SUPABASE_URL"),
    SUPABASE_SERVICE_ROLE_KEY: envPresent("SUPABASE_SERVICE_ROLE_KEY"),
    STAGING_DIRECT_POSTGRES_URL: envPresent("STAGING_DIRECT_POSTGRES_URL"),
    AWS_ACCESS_KEY_ID: envPresent("AWS_ACCESS_KEY_ID"),
    AWS_SECRET_ACCESS_KEY: envPresent("AWS_SECRET_ACCESS_KEY"),
    AWS_REGION: envPresent("AWS_REGION"),
  };

  const supabaseUrl =
    process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const stagingOk = supabaseUrlMatchesStagingRef(supabaseUrl, STAGING_REF);

  let storeCtx: Record<string, unknown> = {};
  let removalActivity: Record<string, unknown> = {};
  let uploadMeta: unknown[] = [];
  let probeResults: unknown[] = [];

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (dbUrl && supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();

    const store = await client.query(
      `SELECT s.id::text, s.name, s.platform, s.marketplace_id,
              m.id::text AS marketplace_row_id, m.provider
       FROM public.stores s
       LEFT JOIN public.marketplaces m ON m.id = s.marketplace_id
       WHERE s.id = $1::uuid AND s.organization_id = $2::uuid`,
      [STORE_ID, ORG_ID],
    );
    storeCtx = (store.rows[0] as Record<string, unknown>) ?? {};

    const act = await client.query(
      `SELECT
         COUNT(*)::int AS detail_rows,
         MIN(order_date)::text AS min_order_date,
         MAX(order_date)::text AS max_order_date,
         COUNT(DISTINCT order_id)::int AS distinct_orders
       FROM public.amazon_removals
       WHERE organization_id = $1::uuid AND store_id = $2::uuid`,
      [ORG_ID, STORE_ID],
    );
    removalActivity = act.rows[0] as Record<string, unknown>;

    const ids = [orderUploadId, shipUploadId].filter(Boolean);
    if (ids.length) {
      const up = await client.query(
        `SELECT id::text, report_type, status, file_name, created_at::text, metadata
         FROM public.raw_report_uploads WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      uploadMeta = up.rows.map((r) => {
        const row = r as Record<string, unknown>;
        const meta = row.metadata as Record<string, unknown> | null;
        const sr =
          meta?.source_run && typeof meta.source_run === "object"
            ? (meta.source_run as Record<string, unknown>)
            : null;
        return {
          id: row.id,
          report_type: row.report_type,
          status: row.status,
          source_run: sr
            ? {
                state: sr.state,
                report_type: sr.report_type,
                operation: sr.operation,
                idempotency_key: sr.idempotency_key,
                window: sr.window,
                external_ids: sr.external_ids,
                marketplace_ids: sr.marketplace_ids,
                attempt: sr.attempt,
              }
            : null,
        };
      });
    }

    await client.end();
  }

  if (probe && orderReportId) {
    try {
      const { resolveReportsApiContext } = await import("../lib/amazon/reports-api-credentials");
      const { ReportsApiClient } = await import("../lib/amazon/reports-api-client");
      const ctxRes = await resolveReportsApiContext(ORG_ID, STORE_ID);
      if (ctxRes.ok) {
        const client = new ReportsApiClient({ context: ctxRes.context });
        for (const [label, rid] of [
          ["removal_order", orderReportId],
          ["removal_shipment", shipReportId],
        ] as const) {
          if (!rid) continue;
          const rep = await client.getReport(rid);
          probeResults.push({
            label,
            report_id: rid,
            processingStatus: rep.processingStatus,
            reportDocumentId: rep.reportDocumentId,
            raw_keys: rep.raw && typeof rep.raw === "object" ? Object.keys(rep.raw as object) : [],
            raw_snippet: JSON.stringify(rep.raw).slice(0, 800),
          });
        }
      } else {
        probeResults.push({ error: ctxRes.error });
      }
    } catch (e) {
      probeResults.push({
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const minDate = String(removalActivity.min_order_date ?? "");
  const maxDate = String(removalActivity.max_order_date ?? "");
  const retryWindows = [
    {
      id: "A_narrow_activity",
      label: "Narrow — DB activity ±7d",
      window_start: minDate
        ? new Date(new Date(minDate).getTime() - 7 * 86400000).toISOString()
        : "2026-03-01T00:00:00.000Z",
      window_end: maxDate
        ? new Date(
            Math.min(Date.now(), new Date(maxDate).getTime() + 7 * 86400000),
          ).toISOString()
        : new Date().toISOString(),
      rationale: "Matches staging seed removal activity; avoids 18-month wide window.",
    },
    {
      id: "B_last_30d",
      label: "Last 30 days UTC",
      window_start: new Date(Date.now() - 30 * 86400000).toISOString(),
      window_end: new Date().toISOString(),
      rationale: "Amazon-friendly short window when recent removals exist.",
    },
    {
      id: "C_calendar_month",
      label: "Prior full calendar month",
      window_start: (() => {
        const d = new Date();
        return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString();
      })(),
      window_end: (() => {
        const d = new Date();
        return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0, 23, 59, 59)).toISOString();
      })(),
      rationale: "Bounded monthly slice; common for scheduled-style backfill.",
    },
  ];

  const rootCauseLikely: string[] = [];
  if (!envAudit.AWS_ACCESS_KEY_ID && !envAudit.STAGING_DIRECT_POSTGRES_URL) {
    rootCauseLikely.push("AWS signing keys may be store-scoped only — verify marketplace credentials blob.");
  }
  if (Number(removalActivity.detail_rows ?? 0) > 0 && latest?.order.Fetched === "no") {
    rootCauseLikely.push(
      "Staging has removal rows but SP-API FATAL — likely seller/credential mismatch OR app lacks FBA Reports role (not empty window alone).",
    );
  }
  if (latest?.order.Window?.includes("2024")) {
    rootCauseLikely.push("Earlier execute used ~18-month window; Amazon may FATAL on oversized ranges.");
  }
  rootCauseLikely.push(
    "createReport succeeded (report_id assigned) but getReport returned FATAL — permission, seller, or non-generatable window for this credential.",
  );

  fs.writeFileSync(
    path.join(outDir, "fetch-failure-extract.md"),
    [
      "# Fetch failure extract",
      "",
      "## Latest execute run",
      "",
      `**Run:** \`${FETCH_BASE}/${latest?.run_id ?? "unknown"}\``,
      "",
      "### REMOVAL_ORDER",
      "",
      "| Field | Value |",
      "|-------|-------|",
      ...Object.entries(latest?.order ?? {}).map(([k, v]) => `| ${k} | \`${v}\` |`),
      "",
      "### REMOVAL_SHIPMENT",
      "",
      "| Field | Value |",
      "|-------|-------|",
      ...Object.entries(latest?.shipment ?? {}).map(([k, v]) => `| ${k} | \`${v}\` |`),
      "",
      "## Recent runs (report_id trail)",
      "",
      ...fetchRuns.flatMap((r) => [
        `### ${r.run_id}`,
        `- order report_id: \`${r.order.report_id ?? "—"}\` state: ${r.order["final_state"] ?? "—"}`,
        `- shipment report_id: \`${r.shipment.report_id ?? "—"}\` state: ${r.shipment["final_state"] ?? "—"}`,
        "",
      ]),
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "env-and-seller-context.md"),
    [
      "# Env and seller context (no secrets)",
      "",
      `| Check | Value |`,
      `|-------|-------|`,
      `| Branch | \`${branch}\` |`,
      `| Staging ref | \`${STAGING_REF}\` |`,
      `| Supabase URL staging match | **${stagingOk}** (${redactUrl(supabaseUrl) || "missing"}) |`,
      `| Org | \`${ORG_ID}\` |`,
      `| Store | \`${STORE_ID}\` |`,
      "",
      "## Env flags present",
      "",
      ...Object.entries(envAudit).map(([k, v]) => `- \`${k}\`: **${v}**`),
      "",
      "## Store / marketplace",
      "",
      "```json",
      JSON.stringify(storeCtx, null, 2),
      "```",
      "",
      "## Staging removal activity (seed / CSV history)",
      "",
      "```json",
      JSON.stringify(removalActivity, null, 2),
      "```",
      "",
      "## Upload metadata (failed placeholders)",
      "",
      "```json",
      JSON.stringify(uploadMeta, null, 2),
      "```",
    ].join("\n") + "\n",
  );

  if (probeResults.length) {
    fs.writeFileSync(
      path.join(outDir, "amazon-get-report-probe.json"),
      JSON.stringify(probeResults, null, 2),
    );
  }

  fs.writeFileSync(
    path.join(outDir, "retry-windows.md"),
    [
      "# Retry windows (recommended order)",
      "",
      ...retryWindows.map(
        (w, i) =>
          [
            `## ${i + 1}. ${w.label} (\`${w.id}\`)`,
            "",
            `- **window_start:** \`${w.window_start}\``,
            `- **window_end:** \`${w.window_end}\``,
            `- **Rationale:** ${w.rationale}`,
            "",
          ].join("\n"),
      ),
      "**Recommended first:** `A_narrow_activity` (aligns with staging `amazon_removals` dates).",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "retry-commands.md"),
    [
      "# Minimal retry commands",
      "",
      "Set flags for the shell session (values not logged):",
      "",
      "```powershell",
      "$env:ENABLE_AMAZON_REPORTS_API_WORKER = \"true\"",
      "$env:ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER = \"true\"",
      "$env:ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT = \"true\"",
      "```",
      "",
      "### Window A (recommended)",
      "",
      "```text",
      `npx tsx scripts/sp-api-removal-reports-fetch-execute.ts --run-id=<UTC_Z> --window-start=${retryWindows[0]!.window_start} --window-end=${retryWindows[0]!.window_end}`,
      "```",
      "",
      "### Window B (30d)",
      "",
      "```text",
      `npx tsx scripts/sp-api-removal-reports-fetch-execute.ts --run-id=<UTC_Z> --window-start=${retryWindows[1]!.window_start} --window-end=${retryWindows[1]!.window_end}`,
      "```",
      "",
      "### Window C (prior month)",
      "",
      "```text",
      `npx tsx scripts/sp-api-removal-reports-fetch-execute.ts --run-id=<UTC_Z> --window-start=${retryWindows[2]!.window_start} --window-end=${retryWindows[2]!.window_end}`,
      "```",
      "",
      "### Diagnostic probe only (no new createReport)",
      "",
      "```powershell",
      "npx tsx scripts/sp-api-removal-reports-fetch-retry-diagnostic.ts --probe",
      "```",
      "",
      "**Do not** run normalized import until `synthetic_upload_ready` + `content_sha256` on both uploads.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "root-cause-analysis.md"),
    [
      "# Root cause analysis",
      "",
      "## Observed behavior",
      "",
      "1. `createReport` **succeeded** — Amazon assigned `report_id` (e.g. order `2015533020600`, shipment `2015534020600`).",
      "2. `getReport` polling reached **`processingStatus=FATAL`** within a few resume rounds.",
      "3. No `reportDocumentId`, no download, `source_run.state=failed`, `last_error_code=report_fatal`.",
      "4. Placeholder `raw_report_uploads` exist but are **not importable**.",
      "",
      "## Likely causes (ranked)",
      "",
      "| Rank | Hypothesis | Evidence |",
      "|------|------------|----------|",
      "| 1 | **SP-API app missing Reports / FBA report roles** | create works; generation FATAL is common when role cannot build report type |",
      "| 2 | **Credential seller ≠ seller that produced staging CSV data** | Staging has ~1.6k removal rows; API FATAL for activity-aligned window |",
      "| 3 | **Window not generatable for this seller** | Wide windows also FATAL; narrow retry still required |",
      "| 4 | Marketplace / region mismatch | Store `marketplace_id` must match authorized retail marketplace |",
      "| 5 | Report type restricted for account | Less common if createReport accepts type |",
      "",
      "## Ruled out (this run)",
      "",
      "- Implementation bug in worker loop (reaches Amazon and records report_id).",
      "- Import/rebuild conflation (runPipeline false; no domain writes).",
      "- Missing env for execute script (flags can be set at runtime).",
      "",
      "## Likely root cause (summary)",
      "",
      rootCauseLikely.map((r) => `- ${r}`).join("\n"),
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    [
      "- Fetch not complete: both reports FATAL.",
      "- Normalized import blocked until synthetic_upload_ready.",
      retryRun ? "- Retry was requested via --retry-run (see manifest)." : "- Retry **not** run in this diagnostic pass.",
    ].join("\n") + "\n",
  );

  const nextPrompt = retryRun
    ? "REMOVAL-NORMALIZED-IMPORT-PLAN-AFTER-FETCH — re-run after successful fetch retry"
    : "SP-API-REMOVAL-REPORTS-FETCH-RETRY-EXECUTE — run fetch with Window A after verifying SP-API FBA Reports role + seller match";

  const manifest = {
    prompt: "SP-API REMOVAL REPORTS FETCH RETRY DIAGNOSTIC",
    run_id: runId,
    branch,
    fetch_run_id: latest?.run_id,
    retry_run_in_this_pass: retryRun,
    probe_run: probe,
    order_report_id: orderReportId,
    shipment_report_id: shipReportId,
    order_status: latest?.order["final_state"] ?? "failed",
    shipment_status: latest?.shipment["final_state"] ?? "failed",
    processing_status: "FATAL",
    uploads_ready: false,
    recommended_retry_window: retryWindows[0],
    root_cause_likely: rootCauseLikely,
    exact_next_prompt: nextPrompt,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(
    JSON.stringify(
      {
        ok: true,
        outDir: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
        root_cause_likely: rootCauseLikely[0],
        recommended_window: retryWindows[0]!.id,
        retry_run: retryRun,
        probe,
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
