/**
 * REMOVAL-RECENT-WINDOW-SUPERVISED-APPLY-BURNIN-STAGING
 *
 *   npx tsx scripts/removal-recent-window-supervised-apply-burnin-staging.ts --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import pg from "pg";

import {
  queryEpAllocationMismatchBreakdown,
  rebuildValidFromBreakdown,
} from "../lib/removal/ep-allocation-mismatch-breakdown";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/removal-recent-window-supervised-apply-burnin-staging";
const RUN_LOCK_PATH = ".cursor/audit-reports/removal-automation-run/.run-lock.json";
const ROLLING_DAYS = 7;
const MIN_LATEST_DATE = "2026-05-29";

const APPROVALS = [
  {
    name: "orchestrator",
    path: ".cursor/operator-approvals/removal-automation-cron-implementation-approval.md",
    flags: ["APPROVED_TO_IMPLEMENT_REMOVAL_AUTOMATION_CRON"],
  },
  {
    name: "fetch",
    path: ".cursor/operator-approvals/sp-api-removal-shipment-fetch-approval.md",
    flags: ["APPROVED_TO_RUN_STAGING", "APPROVED_SP_API_REMOVAL_SHIPMENT_FETCH"],
  },
  {
    name: "domain_sync",
    path: ".cursor/operator-approvals/sp-api-removal-reports-domain-sync-approval.md",
    flags: ["APPROVED_TO_RUN_STAGING", "APPROVED_SP_API_REMOVAL_REPORTS_DOMAIN_SYNC"],
  },
  {
    name: "resolver",
    path: ".cursor/operator-approvals/removal-expected-packages-resolver-backfill-approval.md",
    flags: ["APPROVED_TO_RUN_STAGING", "APPROVED_REMOVAL_EXPECTED_PACKAGES_RESOLVER_BACKFILL"],
  },
] as const;

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

function readFlag(filePath: string, flag: string): boolean {
  const full = path.join(process.cwd(), filePath);
  if (!fs.existsSync(full)) return false;
  return new RegExp(`${flag}\\s*=\\s*true`, "i").test(fs.readFileSync(full, "utf8"));
}

function endOfYesterdayUtc(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

function computeRollingWindow(): {
  start: string;
  end: string;
  rolling_days: number;
} {
  const end = endOfYesterdayUtc();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - ROLLING_DAYS);
  start.setUTCHours(0, 0, 0, 0);
  return { start: start.toISOString(), end: end.toISOString(), rolling_days: ROLLING_DAYS };
}

function readRunLock(): { running: boolean; run_id?: string } {
  const full = path.join(process.cwd(), RUN_LOCK_PATH);
  if (!fs.existsSync(full)) return { running: false };
  try {
    const j = JSON.parse(fs.readFileSync(full, "utf8")) as { status?: string; run_id?: string };
    return { running: j.status === "running", run_id: j.run_id };
  } catch {
    return { running: false };
  }
}

async function postChecks(client: pg.Client): Promise<{
  dup_remainder: number;
  dup_business_key: number;
  mismatch: Awaited<ReturnType<typeof queryEpAllocationMismatchBreakdown>>;
  products: number;
  pim: number;
  max_order_date: string | null;
}> {
  const dupRem = await client.query(
    `SELECT count(*)::int AS c FROM (
       SELECT source_detail_row_id FROM public.expected_packages
       WHERE organization_id=$1::uuid AND build_source='detail_remainder'
       GROUP BY source_detail_row_id HAVING count(*)>1
     ) x`,
    [ORG_ID],
  );
  const dupBiz = await client.query(
    `SELECT count(*)::int AS c FROM (
       SELECT source_detail_row_id, source_shipment_row_id, build_source, allocation_group_key
       FROM public.expected_packages
       WHERE organization_id=$1::uuid AND build_source IN ('detail_shipment','detail_remainder')
       GROUP BY 1,2,3,4 HAVING count(*)>1
     ) x`,
    [ORG_ID],
  );
  const maxDate = await client.query(
    `SELECT max(order_date)::text AS d FROM public.amazon_removals WHERE organization_id=$1::uuid`,
    [ORG_ID],
  );
  const products = await client.query(`SELECT count(*)::int AS c FROM public.products`);
  const pim = await client.query(
    `SELECT count(*)::int AS c FROM public.product_identifier_map WHERE deleted_at IS NULL`,
  );
  const mismatch = await queryEpAllocationMismatchBreakdown(client, ORG_ID, STORE_ID);
  return {
    dup_remainder: (dupRem.rows[0] as { c: number }).c,
    dup_business_key: (dupBiz.rows[0] as { c: number }).c,
    mismatch,
    products: (products.rows[0] as { c: number }).c,
    pim: (pim.rows[0] as { c: number }).c,
    max_order_date: (maxDate.rows[0] as { d: string | null }).d,
  };
}

function readJson<T>(p: string): T | null {
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const apply = hasFlag("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const blockers: string[] = [];
  let branch = "unknown";
  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
  } catch {
    blockers.push("Could not read git branch.");
  }
  if (branch !== "feature/product-canonicalization-v3") {
    blockers.push(`Branch must be feature/product-canonicalization-v3 (got ${branch}).`);
  }

  const lock = readRunLock();
  if (lock.running) blockers.push(`Removal job active (run_id=${lock.run_id ?? "unknown"}).`);

  for (const a of APPROVALS) {
    for (const f of a.flags) {
      if (!readFlag(a.path, f)) blockers.push(`${a.name}: ${f} not true in ${a.path}`);
    }
  }

  if (process.env.REMOVAL_AUTOMATION_APPLY_ENABLED?.trim() === "true") {
    blockers.push("REMOVAL_AUTOMATION_APPLY_ENABLED must remain off (cron apply forbidden).");
  }

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const urlRef = refFromSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "") ?? "";
  if (urlRef === ORIGINAL_REF) blockers.push("Original ref forbidden.");
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset.");
  if (apply && process.env.REMOVAL_AUTOMATION_CONFIRM_APPLY?.trim() !== "true") {
    blockers.push("REMOVAL_AUTOMATION_CONFIRM_APPLY=true required for --apply.");
  }

  const window = computeRollingWindow();
  const windowEndDate = window.end.slice(0, 10);
  const windowStartDate = window.start.slice(0, 10);
  if (windowStartDate < "2025-11-01") {
    blockers.push(`Window start ${windowStartDate} looks historical — expected recent rolling only.`);
  }
  if (windowEndDate < MIN_LATEST_DATE) {
    blockers.push(`Window end ${windowEndDate} is before ${MIN_LATEST_DATE} — not a recent rolling window.`);
  }

  let preChecks: Awaited<ReturnType<typeof postChecks>> | null = null;
  if (dbUrl && !blockers.length) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    preChecks = await postChecks(client);
    await client.end();
  }

  fs.writeFileSync(
    path.join(outDir, "precondition-check.md"),
    [
      "# Precondition check",
      "",
      `| Check | Value |`,
      `|-------|-------|`,
      `| Branch | \`${branch}\` |`,
      `| Run lock | ${lock.running ? "ACTIVE — blocked" : "idle"} |`,
      `| Rolling days | **${ROLLING_DAYS}** |`,
      `| Window | \`${window.start}\` → \`${window.end}\` |`,
      `| Cron apply | **off** (REMOVAL_AUTOMATION_APPLY_ENABLED not true) |`,
      `| Window end (after ${MIN_LATEST_DATE}?) | **${windowEndDate >= MIN_LATEST_DATE ? "yes" : "no"}** (\`${window.end}\`) |`,
      `| Max order_date (pre, informational) | \`${preChecks?.max_order_date ?? "—"}\` |`,
      "",
      blockers.length ? "## Blockers\n\n" + blockers.map((b) => `- ${b}`).join("\n") : "## Blockers\n\n- None",
    ].join("\n") + "\n",
  );

  if (blockers.length) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.map((b) => `- ${b}`).join("\n") + "\n");
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify({ run_id: runId, status: "BLOCKED", blockers, window }, null, 2),
    );
    console.log(JSON.stringify({ ok: false, outDir, blockers }, null, 2));
    process.exit(1);
  }

  if (!apply) {
    fs.writeFileSync(
      path.join(outDir, "dry-run-summary.md"),
      "# Dry-run\n\nPreconditions PASS. Re-run with `--apply` and `REMOVAL_AUTOMATION_CONFIRM_APPLY=true`.\n",
    );
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify({ run_id: runId, status: "DRY_RUN_PASS", window }, null, 2),
    );
    console.log(JSON.stringify({ ok: true, mode: "dry-run", outDir, window }, null, 2));
    return;
  }

  const productsBefore = preChecks!.products;
  const pimBefore = preChecks!.pim;

  process.env.REMOVAL_AUTOMATION_TARGET_REF = STAGING_REF;
  const orchRunId = `${runId}-orch`;
  const orchRes = spawnSync(
    "npx",
    [
      "tsx",
      "scripts/removal-automation-orchestrator.ts",
      "--apply",
      "--manual",
      `--run-id=${orchRunId}`,
      `--rolling-days=${ROLLING_DAYS}`,
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      shell: true,
      encoding: "utf8",
      maxBuffer: 25 * 1024 * 1024,
    },
  );

  fs.writeFileSync(
    path.join(outDir, "orchestrator-exit.json"),
    JSON.stringify(
      {
        exit_code: orchRes.status,
        stdout_tail: orchRes.stdout?.slice(-12000),
        stderr_tail: orchRes.stderr?.slice(-4000),
      },
      null,
      2,
    ),
  );

  const orchManifest = readJson<Record<string, unknown>>(
    path.join(process.cwd(), ".cursor/audit-reports/removal-automation-run", orchRunId, "manifest.json"),
  );
  const verifyManifest = readJson<Record<string, unknown>>(
    path.join(
      process.cwd(),
      ".cursor/audit-reports/removal-quantity-allocation-validation",
      `${orchRunId}-verify`,
      "manifest.json",
    ),
  );
  const resolverManifest = readJson<Record<string, unknown>>(
    path.join(
      process.cwd(),
      ".cursor/audit-reports/removal-post-sync-resolver-reconcile",
      `${orchRunId}-resolver`,
      "manifest.json",
    ),
  );
  const fetchManifest = readJson<Record<string, unknown>>(
    path.join(
      process.cwd(),
      ".cursor/audit-reports/sp-api-removal-reports-fetch-execute",
      `${orchRunId}-fetch`,
      "manifest.json",
    ),
  );
  const syncManifest = readJson<Record<string, unknown>>(
    path.join(
      process.cwd(),
      ".cursor/audit-reports/sp-api-removal-reports-domain-sync-execute",
      `${orchRunId}-sync`,
      "manifest.json",
    ),
  );

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const post = await postChecks(client);
  await client.end();

  const nonOverflowOk = post.mismatch.non_overflow === 0;
  const dupOk = post.dup_remainder === 0 && post.dup_business_key === 0;
  const rebuildValid = rebuildValidFromBreakdown(post.mismatch);
  const orchPass = orchManifest?.status === "PASS" && orchRes.status === 0;
  const resolverPass = resolverManifest?.status === "PASS";
  const verifyPass = verifyManifest?.allocation_contract_valid === true;
  const noProductInsert = post.products === productsBefore && post.pim === pimBefore;

  const status =
    orchPass && verifyPass && resolverPass && nonOverflowOk && dupOk && noProductInsert
      ? "PASS"
      : orchRes.status === 0
        ? "PARTIAL"
        : "FAIL";

  fs.writeFileSync(
    path.join(outDir, "burnin-summary.md"),
    [
      "# Recent window supervised apply burn-in (staging)",
      "",
      `Run: \`${runId}\` · Orchestrator: \`${orchRunId}\` · Status: **${status}**`,
      "",
      "## Window",
      "",
      `- Rolling days: **${ROLLING_DAYS}** (recent only — no Nov/Dec historical fetch)`,
      `- Computed: \`${window.start}\` → \`${window.end}\``,
      `- Orchestrator window: \`${JSON.stringify(orchManifest?.window ?? window)}\``,
      "",
      "## Pipeline steps",
      "",
      "| Step | Status |",
      "|------|--------|",
      `| fetch | ${fetchManifest?.status ?? (orchManifest?.step_results ? "see orchestrator" : "—")} |`,
      `| domain_sync | ${syncManifest?.status ?? "—"} |`,
      `| verify | ${verifyPass ? "PASS" : "FAIL"} (non-overflow=${verifyManifest?.live_vs_sim_non_overflow_mismatch ?? post.mismatch.non_overflow}) |`,
      `| resolver | ${resolverManifest?.status ?? "—"} |`,
      "",
      "## Verification",
      "",
      `| Check | Result |`,
      `|-------|--------|`,
      `| duplicate EP remainder groups | **${post.dup_remainder}** |`,
      `| duplicate EP business-key groups | **${post.dup_business_key}** |`,
      `| non-overflow mismatch | **${post.mismatch.non_overflow}** (${rebuildValid ? "PASS" : "FAIL"}) |`,
      `| overflow mismatch (informational) | **${post.mismatch.overflow}** |`,
      `| products count delta | **${post.products - productsBefore}** |`,
      `| product_identifier_map delta | **${post.pim - pimBefore}** |`,
      `| max order_date (post) | **${post.max_order_date ?? "—"}** |`,
      "",
      "## Cron",
      "",
      "Scheduled cron apply **not enabled** — supervised manual apply only.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "REMOVAL-RECENT-WINDOW-SUPERVISED-APPLY-BURNIN-STAGING",
        run_id: runId,
        branch,
        staging_ref: STAGING_REF,
        status,
        window,
        orchestrator_run_id: orchRunId,
        orchestrator_status: orchManifest?.status,
        fetch: fetchManifest,
        domain_sync: syncManifest,
        verify: verifyManifest,
        resolver: resolverManifest,
        post_checks: {
          duplicate_ep_remainder: post.dup_remainder,
          duplicate_ep_business_key: post.dup_business_key,
          mismatch: post.mismatch,
          rebuild_valid: rebuildValid,
          products_delta: post.products - productsBefore,
          pim_delta: post.pim - pimBefore,
          max_order_date: post.max_order_date,
        },
        exact_next_prompt:
          status === "PASS"
            ? "REMOVAL-DAILY-AUTOMATION-MONITOR — continue dry-run cron; enable scheduled apply only after operator sign-off"
            : "REMOVAL-DAILY-AUTOMATION-DIAGNOSE — inspect orchestrator step-results and blockers",
        forbidden: {
          cron_apply_enabled: false,
          historical_nov_dec_fetch: false,
          original_writes: false,
        },
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: status === "PASS",
        outDir: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
        status,
        window,
        orchPass,
        verifyPass,
        resolverPass,
        non_overflow: post.mismatch.non_overflow,
        dup_ok: dupOk,
      },
      null,
      2,
    ),
  );

  if (status !== "PASS") process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
