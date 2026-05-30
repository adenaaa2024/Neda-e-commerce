/**
 * REMOVAL-DAILY-AUTOMATION-APPLY-BURNIN-STAGING
 * Supervised staging apply with before/after census.
 *
 *   npx tsx scripts/removal-daily-automation-apply-burnin-staging.ts --run-id=<UTC_Z>
 *   npx tsx scripts/removal-daily-automation-apply-burnin-staging.ts --run-id=<UTC_Z> --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const COVERAGE_AUDIT_RUN = "20260607T170000Z";
const COVERAGE_AUDIT_PATH = `.cursor/audit-reports/amazon-removal-api-date-coverage-and-batch-status-readonly/${COVERAGE_AUDIT_RUN}`;
const OUT_BASE = ".cursor/audit-reports/removal-daily-automation-apply-burnin-staging";
const ORCHESTRATOR_APPROVAL =
  ".cursor/operator-approvals/removal-automation-cron-implementation-approval.md";

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

type Snapshot = {
  captured_at: string;
  raw_uploads: number;
  removals: number;
  shipments: number;
  derived_ep: number;
  ep_resolved: number;
  ep_unresolved: number;
  upload_idempotency_dup_keys: number;
  removal_staging_dup_groups: number;
};

async function snapshot(): Promise<Snapshot> {
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const r = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM public.raw_report_uploads WHERE organization_id=$1::uuid AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')) AS raw_uploads,
       (SELECT COUNT(*)::int FROM public.amazon_removals WHERE organization_id=$1::uuid) AS removals,
       (SELECT COUNT(*)::int FROM public.amazon_removal_shipments WHERE organization_id=$1::uuid) AS shipments,
       (SELECT COUNT(*)::int FROM public.expected_packages WHERE organization_id=$1::uuid AND build_source IN ('detail_shipment','detail_remainder')) AS derived_ep,
       (SELECT COUNT(*)::int FROM public.expected_packages WHERE organization_id=$1::uuid AND build_source IN ('detail_shipment','detail_remainder') AND resolved_product_id IS NOT NULL) AS ep_resolved,
       (SELECT COUNT(*)::int FROM public.expected_packages WHERE organization_id=$1::uuid AND build_source IN ('detail_shipment','detail_remainder') AND resolved_product_id IS NULL) AS ep_unresolved,
       (SELECT COUNT(*)::int FROM (
          SELECT metadata->'source_run'->>'idempotency_key' AS idem, COUNT(*) AS c
          FROM public.raw_report_uploads
          WHERE organization_id=$1::uuid AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
            AND metadata->'source_run'->>'idempotency_key' IS NOT NULL
          GROUP BY 1 HAVING COUNT(*) > 1
        ) x) AS upload_idempotency_dup_keys,
       (SELECT COUNT(*)::int FROM (
          SELECT organization_id, upload_id, source_staging_id, COUNT(*) AS c
          FROM public.amazon_removals WHERE organization_id=$1::uuid AND source_staging_id IS NOT NULL
          GROUP BY 1,2,3 HAVING COUNT(*) > 1
        ) x) AS removal_staging_dup_groups`,
    [ORG_ID],
  );
  await client.end();
  const row = r.rows[0] as Record<string, number>;
  return {
    captured_at: new Date().toISOString(),
    raw_uploads: row.raw_uploads,
    removals: row.removals,
    shipments: row.shipments,
    derived_ep: row.derived_ep,
    ep_resolved: row.ep_resolved,
    ep_unresolved: row.ep_unresolved,
    upload_idempotency_dup_keys: row.upload_idempotency_dup_keys,
    removal_staging_dup_groups: row.removal_staging_dup_groups,
  };
}

function delta(before: Snapshot, after: Snapshot): Record<string, number> {
  return {
    raw_uploads: after.raw_uploads - before.raw_uploads,
    removals: after.removals - before.removals,
    shipments: after.shipments - before.shipments,
    derived_ep: after.derived_ep - before.derived_ep,
    ep_resolved: after.ep_resolved - before.ep_resolved,
    ep_unresolved: after.ep_unresolved - before.ep_unresolved,
  };
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

  if (!fs.existsSync(path.join(process.cwd(), COVERAGE_AUDIT_PATH, "manifest.json"))) {
    blockers.push(`Coverage audit missing: ${COVERAGE_AUDIT_PATH}`);
  }

  const coverageNotes: string[] = [];
  const batchLedger = path.join(process.cwd(), COVERAGE_AUDIT_PATH, "batch-ledger-staging.json");
  if (fs.existsSync(batchLedger)) {
    const bl = JSON.parse(fs.readFileSync(batchLedger, "utf8")) as {
      fetch_only_pending_sync?: unknown[];
    };
    if ((bl.fetch_only_pending_sync?.length ?? 0) > 0) {
      coverageNotes.push(
        `Sep 2025 fetch-only uploads pending domain sync (${bl.fetch_only_pending_sync!.length} uploads) — backfill gap, not blocking 7-day rolling burn-in.`,
      );
    }
    coverageNotes.push(
      "Oct–Nov 2025 never fetched on staging — historical backfill gap; daily rolling window unaffected.",
    );
  }

  const orchestratorOk = readFlag(ORCHESTRATOR_APPROVAL, "APPROVED_TO_IMPLEMENT_REMOVAL_AUTOMATION_CRON");
  const fetchOk =
    readFlag(".cursor/operator-approvals/sp-api-removal-shipment-fetch-approval.md", "APPROVED_TO_RUN_STAGING") &&
    readFlag(".cursor/operator-approvals/sp-api-removal-shipment-fetch-approval.md", "APPROVED_SP_API_REMOVAL_SHIPMENT_FETCH");
  const syncOk =
    readFlag(".cursor/operator-approvals/sp-api-removal-reports-domain-sync-approval.md", "APPROVED_TO_RUN_STAGING") &&
    readFlag(".cursor/operator-approvals/sp-api-removal-reports-domain-sync-approval.md", "APPROVED_SP_API_REMOVAL_REPORTS_DOMAIN_SYNC");
  const resolverOk =
    readFlag(".cursor/operator-approvals/removal-expected-packages-resolver-backfill-approval.md", "APPROVED_TO_RUN_STAGING") &&
    readFlag(".cursor/operator-approvals/removal-expected-packages-resolver-backfill-approval.md", "APPROVED_REMOVAL_EXPECTED_PACKAGES_RESOLVER_BACKFILL");

  if (!orchestratorOk) blockers.push("APPROVED_TO_IMPLEMENT_REMOVAL_AUTOMATION_CRON not true.");
  if (!fetchOk) blockers.push("SP-API fetch approval not ready.");
  if (!syncOk) blockers.push("Domain sync approval not ready.");
  if (!resolverOk) blockers.push("Resolver backfill approval not ready.");

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const dbRef =
    refFromSupabaseUrl(dbUrl) ?? dbUrl.match(/\.([a-z]{20})\./)?.[1]?.toLowerCase() ?? null;
  const urlRef = refFromSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "") ?? dbRef;
  if (urlRef === ORIGINAL_REF) blockers.push("Original ref forbidden.");
  if (!dbUrl || dbRef !== STAGING_REF) {
    blockers.push(`STAGING_DIRECT_POSTGRES_URL must target staging ${STAGING_REF} (got ${dbRef ?? "missing"}).`);
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    blockers.push("SUPABASE_SERVICE_ROLE_KEY unset.");
  }

  let ghAvailable = false;
  try {
    execSync("gh --version", { stdio: "pipe" });
    ghAvailable = true;
  } catch {
    coverageNotes.push(
      "`gh` CLI unavailable locally — workflow_dispatch skipped; using local supervised `--apply` equivalent.",
    );
  }

  const applySecretLocal = process.env.REMOVAL_AUTOMATION_CONFIRM_APPLY?.trim() === "true";
  if (apply && !applySecretLocal) {
    blockers.push(
      "REMOVAL_AUTOMATION_CONFIRM_APPLY must be true for --apply (local stand-in for GitHub REMOVAL_AUTOMATION_APPLY_ENABLED).",
    );
  }

  fs.writeFileSync(
    path.join(outDir, "precondition-check.md"),
    [
      "# Precondition check",
      "",
      `| Check | Status |`,
      `|-------|--------|`,
      `| Coverage audit run | \`${COVERAGE_AUDIT_RUN}\` |`,
      `| Branch | \`${branch}\` |`,
      `| Orchestrator approval | ${orchestratorOk ? "PASS" : "FAIL"} |`,
      `| Fetch approval | ${fetchOk ? "PASS" : "FAIL"} |`,
      `| Domain sync approval | ${syncOk ? "PASS" : "FAIL"} |`,
      `| Resolver approval | ${resolverOk ? "PASS" : "FAIL"} |`,
      `| Staging DB | ${dbUrl ? STAGING_REF : "missing"} |`,
      `| gh CLI | ${ghAvailable ? "available" : "unavailable"} |`,
      `| Apply secret (local) | ${applySecretLocal ? "true" : "false"} |`,
      "",
      "## Coverage notes (not hard-blocking daily burn-in)",
      "",
      ...coverageNotes.map((n) => `- ${n}`),
      "",
      blockers.length ? "## Blockers\n\n" + blockers.map((b) => `- ${b}`).join("\n") : "## Blockers\n\n- None",
    ].join("\n") + "\n",
  );

  if (blockers.length) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.map((b) => `- ${b}`).join("\n") + "\n");
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify({ run_id: runId, status: "BLOCKED", blockers }, null, 2),
    );
    console.log(JSON.stringify({ ok: false, outDir, blockers }, null, 2));
    process.exit(1);
  }

  const before = await snapshot();
  fs.writeFileSync(path.join(outDir, "before-snapshot.json"), JSON.stringify(before, null, 2));

  if (!apply) {
    fs.writeFileSync(
      path.join(outDir, "dry-run-summary.md"),
      [
        "# Burn-in dry-run",
        "",
        "Preconditions PASS. Re-run with `--apply` and `REMOVAL_AUTOMATION_CONFIRM_APPLY=true`.",
        "",
        "Before snapshot captured; orchestrator not executed.",
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify({ run_id: runId, status: "DRY_RUN_PASS", before }, null, 2),
    );
    console.log(JSON.stringify({ ok: true, mode: "dry-run", outDir, before }, null, 2));
    return;
  }

  process.env.REMOVAL_AUTOMATION_TARGET_REF = STAGING_REF;
  process.env.ENABLE_AMAZON_REPORTS_API_WORKER = "true";
  process.env.ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER = "true";
  process.env.ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT = "true";
  process.env.ENABLE_IMPORT_DESCRIPTOR_METADATA = "true";

  const orchRunId = `${runId}-orch`;
  const orchArgs = [
    "tsx",
    "scripts/removal-automation-orchestrator.ts",
    "--apply",
    "--manual",
    `--run-id=${orchRunId}`,
  ];
  if (hasFlag("--skip-fetch")) orchArgs.push("--skip-fetch");
  if (hasFlag("--skip-domain-sync")) orchArgs.push("--skip-domain-sync");
  const orchRes = spawnSync("npx", orchArgs, {
    cwd: process.cwd(),
    env: process.env,
    shell: true,
    encoding: "utf8",
  });

  fs.writeFileSync(
    path.join(outDir, "orchestrator-exit.json"),
    JSON.stringify(
      { exit_code: orchRes.status, signal: orchRes.signal, stdout: orchRes.stdout?.slice(-8000), stderr: orchRes.stderr?.slice(-8000) },
      null,
      2,
    ),
  );

  const after = await snapshot();
  fs.writeFileSync(path.join(outDir, "after-snapshot.json"), JSON.stringify(after, null, 2));
  const deltas = delta(before, after);
  fs.writeFileSync(path.join(outDir, "deltas.json"), JSON.stringify(deltas, null, 2));

  const orchManifestPath = path.join(
    process.cwd(),
    ".cursor/audit-reports/removal-automation-run",
    orchRunId,
    "manifest.json",
  );
  let orchManifest: Record<string, unknown> = {};
  if (fs.existsSync(orchManifestPath)) {
    orchManifest = JSON.parse(fs.readFileSync(orchManifestPath, "utf8")) as Record<string, unknown>;
  }

  const dupOk =
    after.upload_idempotency_dup_keys <= before.upload_idempotency_dup_keys + 2 &&
    after.removal_staging_dup_groups === 0;

  const status = orchRes.status === 0 ? "PASS" : "FAIL";

  fs.writeFileSync(
    path.join(outDir, "burnin-summary.md"),
    [
      "# Removal daily automation apply burn-in (staging)",
      "",
      `Run: \`${runId}\` · Orchestrator: \`${orchRunId}\` · Status: **${status}**`,
      "",
      "## Execution path",
      "",
      ghAvailable
        ? "- GitHub workflow_dispatch (not used — local supervised apply)"
        : "- **Local supervised apply** (`gh` unavailable; equivalent to workflow_dispatch apply=true)",
      "",
      "## Window (from orchestrator)",
      "",
      `\`${JSON.stringify(orchManifest.window ?? "see removal-automation-run")}\``,
      "",
      "## Deltas",
      "",
      "| Metric | Before | After | Delta |",
      "|--------|-------:|------:|------:|",
      `| raw_report_uploads | ${before.raw_uploads} | ${after.raw_uploads} | ${deltas.raw_uploads} |`,
      `| amazon_removals | ${before.removals} | ${after.removals} | ${deltas.removals} |`,
      `| amazon_removal_shipments | ${before.shipments} | ${after.shipments} | ${deltas.shipments} |`,
      `| expected_packages (derived) | ${before.derived_ep} | ${after.derived_ep} | ${deltas.derived_ep} |`,
      `| EP resolved | ${before.ep_resolved} | ${after.ep_resolved} | ${deltas.ep_resolved} |`,
      `| EP unresolved | ${before.ep_unresolved} | ${after.ep_unresolved} | ${deltas.ep_unresolved} |`,
      "",
      "## Duplicate prevention",
      "",
      `| Probe | Before | After | OK |`,
      `|-------|-------:|------:|:---:|`,
      `| upload idempotency dup keys | ${before.upload_idempotency_dup_keys} | ${after.upload_idempotency_dup_keys} | ${after.upload_idempotency_dup_keys <= before.upload_idempotency_dup_keys + 2 ? "yes" : "review"} |`,
      `| removal staging dup groups | ${before.removal_staging_dup_groups} | ${after.removal_staging_dup_groups} | ${after.removal_staging_dup_groups === 0 ? "yes" : "no"} |`,
      "",
      `Overall duplicate check: **${dupOk ? "PASS" : "REVIEW"}**`,
      "",
      "## Cron apply",
      "",
      "**Not enabled** — scheduled GitHub cron remains dry-run only.",
      "",
      "## Orchestrator manifest",
      "",
      `\`\`\`json`,
      JSON.stringify(orchManifest, null, 2),
      `\`\`\``,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "REMOVAL-DAILY-AUTOMATION-APPLY-BURNIN-STAGING",
        run_id: runId,
        orchestrator_run_id: orchRunId,
        status,
        staging_ref: STAGING_REF,
        coverage_audit_run: COVERAGE_AUDIT_RUN,
        before,
        after,
        deltas,
        duplicate_prevention: dupOk ? "PASS" : "REVIEW",
        cron_apply_enabled: false,
        execution_path: ghAvailable ? "local_apply" : "local_apply_gh_unavailable",
        orchestrator_manifest: orchManifest,
      },
      null,
      2,
    ),
  );

  console.log(JSON.stringify({ ok: status === "PASS", outDir, status, deltas }, null, 2));
  process.exit(orchRes.status === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
