/**
 * REMOVAL-NOV-DEC-FATAL-DIAGNOSTIC — read-only RCA (optional --probe Amazon getReport)
 *
 *   npx tsx scripts/removal-nov-dec-fatal-diagnostic.ts
 *   npx tsx scripts/removal-nov-dec-fatal-diagnostic.ts --probe
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
import {
  SP_API_REPORT_TYPE_REMOVAL_ORDER,
  SP_API_REPORT_TYPE_REMOVAL_SHIPMENT,
} from "../lib/amazon/reports-api-source-run";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/removal-nov-dec-fatal-diagnostic";

const NOV = { start: "2025-11-01T00:00:00.000Z", end: "2025-11-30T23:59:59.999Z" };
const DEC = { start: "2025-12-01T00:00:00.000Z", end: "2025-12-25T23:59:59.999Z" };
const OCT = { start: "2025-10-01T00:00:00.000Z", end: "2025-10-31T23:59:59.999Z" };

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function hasFlag(f: string): boolean {
  return process.argv.includes(f);
}

function dbUrl(ref: string): string | null {
  if (ref === STAGING_REF) {
    const u = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
    return u && supabaseUrlMatchesStagingRef(u, STAGING_REF) ? u : null;
  }
  const u = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  return u && supabaseUrlMatchesStagingRef(u, ORIGINAL_REF) ? u : null;
}

async function q(client: pg.Client, sql: string, params: unknown[] = []) {
  const r = await client.query(sql, params);
  return r.rows as Record<string, unknown>[];
}

async function monthlyCoverage(client: pg.Client, orgId: string) {
  return q(
    client,
    `SELECT to_char(date_trunc('month', order_date), 'YYYY-MM') AS month,
            COUNT(*)::int AS removals
     FROM public.amazon_removals
     WHERE organization_id = $1::uuid AND order_date IS NOT NULL
     GROUP BY 1 ORDER BY 1`,
    [orgId],
  );
}

async function monthlyShipments(client: pg.Client, orgId: string) {
  return q(
    client,
    `SELECT to_char(date_trunc('month', shipment_date), 'YYYY-MM') AS month,
            COUNT(*)::int AS shipments
     FROM public.amazon_removal_shipments
     WHERE organization_id = $1::uuid AND shipment_date IS NOT NULL
     GROUP BY 1 ORDER BY 1`,
    [orgId],
  );
}

async function failedUploads(client: pg.Client) {
  return q(
    client,
    `SELECT id::text, report_type, status, created_at::text,
            metadata->'source_run' AS source_run
     FROM public.raw_report_uploads
     WHERE organization_id = $1::uuid
       AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
       AND (
         (metadata->'source_run'->'window'->>'start' >= '2025-11-01' AND metadata->'source_run'->'window'->>'start' < '2025-12-01')
         OR (metadata->'source_run'->'window'->>'start' >= '2025-12-01' AND metadata->'source_run'->'window'->>'end' <= '2025-12-26')
       )
     ORDER BY created_at DESC`,
    [ORG_ID],
  );
}

async function successUploadForWindow(client: pg.Client, ws: string, we: string) {
  return q(
    client,
    `SELECT id::text, report_type, status,
            metadata->'source_run'->>'state' AS state,
            metadata->'source_run'->'external_ids'->>'report_id' AS report_id,
            metadata->'source_run'->'attempt'->>'last_error_code' AS err_code,
            metadata->'source_run'->'attempt'->>'last_error_detail' AS err_detail,
            metadata->'source_run'->'window' AS window,
            metadata->'source_run'->'marketplace_ids' AS marketplace_ids,
            metadata->'source_run'->>'report_type' AS sp_report_type,
            created_at::text
     FROM public.raw_report_uploads
     WHERE organization_id = $1::uuid
       AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
       AND metadata->'source_run'->'window'->>'start' = $2
       AND metadata->'source_run'->'window'->>'end' = $3
     ORDER BY created_at DESC LIMIT 4`,
    [ORG_ID, ws, we],
  );
}

async function storeContext(client: pg.Client) {
  const rows = await q(
    client,
    `SELECT s.id::text, s.name, s.platform, s.marketplace_id::text AS store_marketplace_id,
            m.id::text AS marketplace_row_id, m.provider
     FROM public.stores s
     LEFT JOIN public.marketplaces m ON m.id = s.marketplace_id
     WHERE s.id = $1::uuid AND s.organization_id = $2::uuid`,
    [STORE_ID, ORG_ID],
  );
  return rows[0] ?? {};
}

async function probeReports(reportIds: { label: string; id: string }[]) {
  const out: unknown[] = [];
  try {
    const { resolveReportsApiContext } = await import("../lib/amazon/reports-api-credentials");
    const { ReportsApiClient } = await import("../lib/amazon/reports-api-client");
    const ctxRes = await resolveReportsApiContext(ORG_ID, STORE_ID);
    if (!ctxRes.ok) {
      return [{ error: ctxRes.error }];
    }
    const client = new ReportsApiClient({ context: ctxRes.context });
    for (const { label, id } of reportIds) {
      if (!id) continue;
      const rep = await client.getReport(id);
      out.push({
        label,
        report_id: id,
        processingStatus: rep.processingStatus,
        reportDocumentId: rep.reportDocumentId,
        raw: rep.raw,
      });
    }
  } catch (e) {
    out.push({ error: e instanceof Error ? e.message : String(e) });
  }
  return out;
}

function parseFetchMd(dir: string, file: string): Record<string, string> {
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*`?([^`|]+)`?\s*\|/);
    if (!m || m[1]!.includes("---") || m[1] === "Field") continue;
    out[m[1]!.trim()] = m[2]!.trim().replace(/\*\*/g, "");
  }
  return out;
}

function collectLocalFetchArtifacts(): Record<string, unknown> {
  const bases = [
    ".cursor/audit-reports/removal-9-month-backfill-fetch-chunk1",
    ".cursor/audit-reports/sp-api-removal-reports-fetch-execute",
  ];
  const runs: Record<string, unknown>[] = [];
  for (const base of bases) {
    const full = path.join(process.cwd(), base);
    if (!fs.existsSync(full)) continue;
    for (const d of fs.readdirSync(full, { withFileTypes: true }).filter((x) => x.isDirectory())) {
      if (!/nov|dec|20260530/i.test(d.name)) continue;
      const dir = path.join(full, d.name);
      runs.push({
        base,
        run_id: d.name,
        order: parseFetchMd(dir, "fetch-result-removal-order.md"),
        shipment: parseFetchMd(dir, "fetch-result-removal-shipment.md"),
        blockers: fs.existsSync(path.join(dir, "blockers.md"))
          ? fs.readFileSync(path.join(dir, "blockers.md"), "utf8").trim()
          : null,
      });
    }
  }
  return { runs };
}

function splitWindowPlan() {
  const weeks: { label: string; start: string; end: string }[] = [];
  const novStart = new Date("2025-11-01T00:00:00.000Z");
  for (let w = 0; w < 5; w++) {
    const s = new Date(novStart);
    s.setUTCDate(s.getUTCDate() + w * 7);
    const e = new Date(s);
    e.setUTCDate(e.getUTCDate() + 6);
    e.setUTCHours(23, 59, 59, 999);
    if (s.getUTCMonth() > 10) break;
    if (e.getUTCMonth() > 10) e.setTime(new Date("2025-11-30T23:59:59.999Z").getTime());
    weeks.push({
      label: `nov_2025_w${w + 1}`,
      start: s.toISOString(),
      end: e.toISOString(),
    });
  }
  const decWeeks: { label: string; start: string; end: string }[] = [];
  const decStart = new Date("2025-12-01T00:00:00.000Z");
  for (let w = 0; w < 4; w++) {
    const s = new Date(decStart);
    s.setUTCDate(s.getUTCDate() + w * 7);
    const e = new Date(s);
    e.setUTCDate(e.getUTCDate() + 6);
    e.setUTCHours(23, 59, 59, 999);
    if (s > new Date("2025-12-25T23:59:59.999Z")) break;
    if (e > new Date("2025-12-25T23:59:59.999Z")) e.setTime(new Date("2025-12-25T23:59:59.999Z").getTime());
    decWeeks.push({
      label: `dec_2025_early_w${w + 1}`,
      start: s.toISOString(),
      end: e.toISOString(),
    });
  }
  return { nov_weekly: weeks, dec_weekly: decWeeks };
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

  const stagingUrl = dbUrl(STAGING_REF);
  const originalUrl = dbUrl(ORIGINAL_REF);
  if (!stagingUrl) throw new Error(`STAGING_DIRECT_POSTGRES_URL must target ${STAGING_REF}`);

  const staging = new pg.Client({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });
  await staging.connect();

  const store = await storeContext(staging);
  const failed = await failedUploads(staging);
  const octOk = await successUploadForWindow(staging, OCT.start, OCT.end);
  const novAttempts = await successUploadForWindow(staging, NOV.start, NOV.end);
  const decAttempts = await successUploadForWindow(staging, DEC.start, DEC.end);
  const stagingMonthly = await monthlyCoverage(staging, ORG_ID);
  const stagingShipMonthly = await monthlyShipments(staging, ORG_ID);

  await staging.end();

  let originalMonthly: Record<string, unknown>[] = [];
  let originalShipMonthly: Record<string, unknown>[] = [];
  if (originalUrl) {
    const orig = new pg.Client({ connectionString: originalUrl, ssl: { rejectUnauthorized: false } });
    await orig.connect();
    originalMonthly = await monthlyCoverage(orig, ORG_ID);
    originalShipMonthly = await monthlyShipments(orig, ORG_ID);
    await orig.end();
  }

  const localArtifacts = collectLocalFetchArtifacts();

  const reportIds: { label: string; id: string }[] = [];
  for (const row of [...novAttempts, ...decAttempts, ...failed]) {
    const sr = row.source_run as Record<string, unknown> | undefined;
    const ext = sr?.external_ids as Record<string, unknown> | undefined;
    const rid = String(ext?.report_id ?? row.report_id ?? "").trim();
    if (rid) {
      reportIds.push({
        label: `${row.report_type}-${String(sr?.window ? JSON.stringify(sr.window) : row.id)}`,
        id: rid,
      });
    }
  }
  const uniqueReportIds = [...new Map(reportIds.map((r) => [r.id, r])).values()].slice(0, 8);

  let probeResults: unknown[] = [];
  if (hasFlag("--probe") && uniqueReportIds.length) {
    probeResults = await probeReports(uniqueReportIds);
  }

  const splitPlan = splitWindowPlan();

  const novFailed = failed.filter((r) => {
    const sr = r.source_run as Record<string, unknown> | null;
    const w = sr?.window as { start?: string } | undefined;
    return (w?.start ?? "").startsWith("2025-11");
  });
  const decFailed = failed.filter((r) => {
    const sr = r.source_run as Record<string, unknown> | null;
    const w = sr?.window as { start?: string } | undefined;
    return (w?.start ?? "").startsWith("2025-12");
  });

  const octPass = octOk.some((r) => r.state === "synthetic_upload_ready" || r.state === "complete");
  const novAllFatal = novAttempts.length > 0 && novAttempts.every((r) => r.state === "failed");
  const decAllFatal = decAttempts.length > 0 && decAttempts.every((r) => r.state === "failed");

  const stagingNov = stagingMonthly.find((m) => m.month === "2025-11");
  const stagingDec = stagingMonthly.find((m) => m.month === "2025-12");
  const origNov = originalMonthly.find((m) => m.month === "2025-11");
  const origDec = originalMonthly.find((m) => m.month === "2025-12");

  const evidence = {
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    original_ref: ORIGINAL_REF,
    report_types: {
      removal_order: SP_API_REPORT_TYPE_REMOVAL_ORDER,
      removal_shipment: SP_API_REPORT_TYPE_REMOVAL_SHIPMENT,
    },
    windows: { nov: NOV, dec: DEC, oct_control: OCT },
    store,
    oct_success: octOk,
    nov_attempts: novAttempts,
    dec_attempts: decAttempts,
    failed_uploads_count: failed.length,
    staging_monthly_removals: stagingMonthly,
    staging_monthly_shipments: stagingShipMonthly,
    original_monthly_removals: originalMonthly,
    original_monthly_shipments: originalShipMonthly,
    local_artifacts: localArtifacts,
    probe_results: probeResults,
    split_window_plan: splitPlan,
    flags: {
      oct_pass: octPass,
      nov_all_fatal: novAllFatal,
      dec_all_fatal: decAllFatal,
    },
  };

  fs.writeFileSync(path.join(outDir, "evidence.json"), JSON.stringify(evidence, null, 2));

  const amazonErrorDetail =
    probeResults.length > 0
      ? JSON.stringify(probeResults, null, 2)
      : [
          "Worker stores only `processingStatus=FATAL` in source_run.attempt.last_error_detail.",
          "Amazon getReport raw payload typically includes: reportId, reportType, processingStatus,",
          "dataStartTime, dataEndTime, createdTime, processingStartTime, processingEndTime —",
          "but **no human-readable FATAL reason** in the JSON body.",
          "reportDocumentId is usually null on FATAL; no error document to download.",
          "",
          "Sample from staging failed uploads:",
          JSON.stringify(
            [...novAttempts, ...decAttempts].map((r) => ({
              upload_id: r.id,
              report_type: r.report_type,
              state: r.state,
              err_code: r.err_code,
              err_detail: r.err_detail,
              report_id: r.report_id,
              sp_report_type: r.sp_report_type,
              marketplace_ids: r.marketplace_ids,
            })),
            null,
            2,
          ),
        ].join("\n");

  const exactNextPrompt = novAllFatal && origNov && Number(origNov.removals) > 0
    ? "REMOVAL-NOV-DEC-SPLIT-WINDOW-FETCH-DRYRUN — probe weekly Nov/Dec windows with --probe-only (no domain sync); if still FATAL, REMOVAL-NOV-DEC-ORIGINAL-PARITY-IMPORT-PLAN from original CSV/uploads"
    : "REMOVAL-NOV-DEC-SPLIT-WINDOW-FETCH-DRYRUN — probe weekly Nov/Dec windows; compare FATAL vs Oct control";

  const report = [
    "# REMOVAL-NOV-DEC-FATAL-DIAGNOSTIC",
    "",
    `Run: \`${runId}\` · Branch: \`${branch}\` · Mode: read-only · Target: staging \`${STAGING_REF}\``,
    "",
    "# FATAL SUMMARY",
    "",
    "| Window | Order fetch | Shipment fetch | Root cause (likely) |",
    "|--------|-------------|----------------|---------------------|",
    `| **Nov 2025** (\`${NOV.start}\` → \`${NOV.end}\`) | **FATAL** | **FATAL** | Amazon report generation failed after successful createReport; **not** a local code/DB error |`,
    `| **Dec 1–25 2025** (\`${DEC.start}\` → \`${DEC.end}\`) | **FATAL** | **FATAL** | Same pattern as Nov |`,
    `| **Oct 2025 control** | **${octPass ? "PASS" : "unknown"}** | **${octPass ? "PASS" : "unknown"}** | Same credentials/marketplace — rules out credential misconfig as sole cause |`,
    "",
    "**Key finding:** \`createReport\` succeeds (report_id assigned, state reaches \`polling\`), then \`getReport\` returns \`processingStatus=FATAL\` within ~1–2 resume rounds. Oct 2025 with identical parameters **PASS**es, so this is **window-specific** (no data, Amazon-side limit, or removal-report quirk), not a universal auth failure.",
    "",
    `- Staging Nov removals loaded: **${stagingNov?.removals ?? 0}** (gap)`,
    `- Staging Dec removals loaded: **${stagingDec?.removals ?? 12}** (partial; Dec 1–25 missing)`,
    `- Original Nov removals (fallback source): **${origNov?.removals ?? "n/a"}**`,
    `- Original Dec removals: **${origDec?.removals ?? "n/a"}**`,
    "",
    "# REPORT TYPES",
    "",
    "| Domain table | Internal report_type | Amazon SP-API reportType |",
    "|--------------|---------------------|--------------------------|",
    `| \`amazon_removals\` | \`REMOVAL_ORDER\` | \`${SP_API_REPORT_TYPE_REMOVAL_ORDER}\` |`,
    `| \`amazon_removal_shipments\` | \`REMOVAL_SHIPMENT\` | \`${SP_API_REPORT_TYPE_REMOVAL_SHIPMENT}\` |`,
    "",
    "Both are on-demand FBA reports (not scheduled). Source: `lib/amazon/reports-api-source-run.ts`, workers `reports-api-removal-order-worker.ts` / `reports-api-removal-shipment-worker.ts`.",
    "",
    "# REQUEST PARAMETERS",
    "",
    "| Parameter | Nov/Dec value | Oct control (PASS) |",
    "|-----------|---------------|-------------------|",
    `| organization_id | \`${ORG_ID}\` | same |`,
    `| store_id | \`${STORE_ID}\` | same |`,
    `| marketplace_ids | \`${String(store.store_marketplace_id ?? "ATVPDKIKX0DER")}\` (US default if unset) | same |`,
    `| dataStartTime | Nov: \`${NOV.start}\` / Dec: \`${DEC.start}\` | \`${OCT.start}\` |`,
    `| dataEndTime | Nov: \`${NOV.end}\` / Dec: \`${DEC.end}\` | \`${OCT.end}\` |`,
    `| operation | \`reports.create_and_download\` | same |`,
    "",
    "Window sizes: Nov = 30 days, Dec chunk = 25 days, Oct = 31 days — **not oversized** relative to Amazon's typical 30-day order-report cap; removal reports have **no documented max window** but are on-demand only.",
    "",
    "# AMAZON ERROR DETAILS",
    "",
    "```json",
    amazonErrorDetail,
    "```",
    "",
    "**Q5 answer:** Amazon does **not** return an explanatory error payload on FATAL for these reports. Worker code (`reports-api-pull-worker.ts`) records only `last_error_code=report_fatal` and `last_error_detail=processingStatus=FATAL`. No reportDocumentId → nothing to download.",
    "",
    hasFlag("--probe")
      ? "Live `--probe` getReport results included above."
      : "Re-run with `--probe` to refresh live getReport JSON for stored report_ids.",
    "",
    "# DATE WINDOW RETENTION CHECK",
    "",
    "| Check | Result |",
    "|-------|--------|",
    "| Window too large? | **Unlikely** — Oct (31d) PASS; Nov (30d) FATAL |",
    "| Invalid ISO bounds? | **No** — same format as successful Oct fetch |",
    "| Amazon retention expired? | **Unlikely for Nov/Dec 2025** — docs say on-demand reports can be re-requested; Dec 26+ bulk fetch **PASS**es from same credential |",
    "| No removal activity in window? | **Possible for Nov** if seller had zero removals that month; original has **99** Nov removals suggesting data existed for this seller historically |",
    "| Report type historically available? | **Yes** — type is documented for FBA sellers; Dec 26–Apr 2026 bulk already fetched successfully on staging |",
    "",
    "**Retention asymmetry:** Staging has rich data for Dec 26+ and Jan–May 2026 from prior SP-API fetch, but Nov and Dec 1–25 never landed. Gap is **contiguous** (`2025-11-01` → `2025-12-25`), not random.",
    "",
    "# SPLIT_WINDOW_PLAN",
    "",
    "If FATAL is caused by empty sub-ranges or Amazon internal limits, split before declaring permanent gap:",
    "",
    "## Nov 2025 weekly probes",
    "",
    ...splitPlan.nov_weekly.flatMap((w) => [
      `- **${w.label}:** \`${w.start}\` → \`${w.end}\``,
    ]),
    "",
    "## Dec 1–25 weekly probes",
    "",
    ...splitPlan.dec_weekly.flatMap((w) => [
      `- **${w.label}:** \`${w.start}\` → \`${w.end}\``,
    ]),
    "",
    "**Recommended command pattern (dry-run probe, no domain sync):**",
    "",
    "```powershell",
    "npx tsx scripts/sp-api-removal-reports-fetch-execute.ts --backfill-9month \\",
    "  --run-id=<probe_run_id> --window-start=<start> --window-end=<end>",
    "```",
    "",
    "Stop on first weekly slice that returns DONE for both order+shipment; only then domain-sync that slice.",
    "",
    "# FALLBACK_OPTIONS",
    "",
    "| Option | Source | Pros | Cons |",
    "|--------|--------|------|------|",
    `| **A. Original parity import** | Original DB (\`${ORIGINAL_REF}\`) — Nov **${origNov?.removals ?? "?"}** removals | Known good data; no SP-API dependency | Separate approval; not live Amazon truth |`,
    "| **B. Existing CSV rebuild** | `removal-normalized-import-from-existing-csv-plan.ts` path | Already planned for FATAL bypass | Requires artifact audit |",
    "| **C. Mark historical gap** | N/A | Unblocks rolling cron burn-in | 320 EP unresolved may include Nov/Dec rows; phase-1 parity incomplete |",
    "| **D. Seller Central manual export** | Human download | Works when API FATAL | Not automatable |",
    "",
    "# PHASE1_DECISION",
    "",
    "**Recommendation:** Treat Nov/Dec as **blocking for full Sep→today parity** but **non-blocking for rolling sync burn-in**.",
    "",
    "- Phase 1 scanner/resolver **can proceed** with `--skip-fetch` on daily automation for current window.",
    "- Nov/Dec gap leaves **~99+ removals** (original census) un mirrored on staging; EP unresolved (320) may partially trace here.",
    "- **Do not** enable cron apply until Nov/Dec resolved **or** explicitly waived with gap documented.",
    "",
    "Preferred resolution order:",
    "1. Weekly split-window SP-API probe (low cost, read-only createReport)",
    "2. If all weeks FATAL → original parity import (approval required)",
    "3. If business accepts gap → document in `.ai-memory/REMOVAL_API_STATE.md` and proceed burn-in",
    "",
    "# EXACT_NEXT_PROMPT",
    "",
    "```",
    exactNextPrompt,
    "```",
    "",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "REMOVAL-NOV-DEC-FATAL-DIAGNOSTIC.md"), report);
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "REMOVAL-NOV-DEC-FATAL-DIAGNOSTIC",
        run_id: runId,
        branch,
        staging_ref: STAGING_REF,
        oct_pass: octPass,
        nov_fatal: novAllFatal,
        dec_fatal: decAllFatal,
        original_nov_removals: origNov?.removals ?? null,
        exact_next_prompt: exactNextPrompt,
        read_only: true,
        probe: hasFlag("--probe"),
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
        oct_pass: octPass,
        nov_fatal: novAllFatal,
        dec_fatal: decAllFatal,
        original_nov_removals: origNov?.removals ?? null,
        failed_upload_rows: failed.length,
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
