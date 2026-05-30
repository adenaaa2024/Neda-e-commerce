/**
 * REMOVAL-STAGING-GAP-FETCH-SYNC — staging gap backfill orchestrator
 *
 *   npx tsx scripts/removal-staging-gap-fetch-sync.ts --run-id=<UTC_Z>
 *   npx tsx scripts/removal-staging-gap-fetch-sync.ts --run-id=<UTC_Z> --apply
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
const REQUIRED_BRANCH = "feature/product-canonicalization-v3";
const OUT_BASE = ".cursor/audit-reports/removal-staging-gap-fetch-sync";

const SEP_ORDER_UPLOAD = "06ddd21c-6eee-4e44-907e-c2586ebdde51";
const SEP_SHIPMENT_UPLOAD = "3e682300-5ba3-481b-9895-69607069d933";

type GapChunk = {
  key: string;
  label: string;
  fetch: boolean;
  window_start?: string;
  window_end?: string;
  order_upload_id?: string;
  shipment_upload_id?: string;
};

const GAP_CHUNKS: GapChunk[] = [
  {
    key: "sep_2025_sync",
    label: "Sep 2025 (pending fetch-only uploads)",
    fetch: false,
    order_upload_id: SEP_ORDER_UPLOAD,
    shipment_upload_id: SEP_SHIPMENT_UPLOAD,
  },
  {
    key: "oct_2025",
    label: "Oct 2025",
    fetch: true,
    window_start: "2025-10-01T00:00:00.000Z",
    window_end: "2025-10-31T23:59:59.999Z",
  },
  {
    key: "nov_2025",
    label: "Nov 2025",
    fetch: true,
    window_start: "2025-11-01T00:00:00.000Z",
    window_end: "2025-11-30T23:59:59.999Z",
  },
  {
    key: "dec_2025_early",
    label: "Dec 1–25 2025",
    fetch: true,
    window_start: "2025-12-01T00:00:00.000Z",
    window_end: "2025-12-25T23:59:59.999Z",
  },
];

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
  removals: number;
  shipments: number;
  derived_ep: number;
  ep_resolved: number;
  ep_unresolved: number;
  raw_uploads: number;
  products: number;
  pim: number;
  upload_idempotency_dup_keys: number;
  removal_staging_dup_groups: number;
};

async function snapshot(): Promise<Snapshot> {
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL!.trim();
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const r = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM public.amazon_removals WHERE organization_id=$1::uuid) AS removals,
       (SELECT COUNT(*)::int FROM public.amazon_removal_shipments WHERE organization_id=$1::uuid) AS shipments,
       (SELECT COUNT(*)::int FROM public.expected_packages WHERE organization_id=$1::uuid AND build_source IN ('detail_shipment','detail_remainder')) AS derived_ep,
       (SELECT COUNT(*)::int FROM public.expected_packages WHERE organization_id=$1::uuid AND build_source IN ('detail_shipment','detail_remainder') AND resolved_product_id IS NOT NULL) AS ep_resolved,
       (SELECT COUNT(*)::int FROM public.expected_packages WHERE organization_id=$1::uuid AND build_source IN ('detail_shipment','detail_remainder') AND resolved_product_id IS NULL) AS ep_unresolved,
       (SELECT COUNT(*)::int FROM public.raw_report_uploads WHERE organization_id=$1::uuid AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')) AS raw_uploads,
       (SELECT COUNT(*)::int FROM public.products) AS products,
       (SELECT COUNT(*)::int FROM public.product_identifier_map) AS pim,
       (SELECT COUNT(*)::int FROM (
          SELECT metadata->'source_run'->>'idempotency_key' AS idem, COUNT(*) AS c
          FROM public.raw_report_uploads WHERE organization_id=$1::uuid AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
            AND metadata->'source_run'->>'idempotency_key' IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1
        ) x) AS upload_idempotency_dup_keys,
       (SELECT COUNT(*)::int FROM (
          SELECT organization_id, upload_id, source_staging_id, COUNT(*) AS c
          FROM public.amazon_removals WHERE organization_id=$1::uuid AND source_staging_id IS NOT NULL
          GROUP BY 1,2,3 HAVING COUNT(*) > 1
        ) x) AS removal_staging_dup_groups`,
    [ORG_ID],
  );
  await client.end();
  return r.rows[0] as Snapshot;
}

function runCmd(label: string, argv: string[], extraEnv: Record<string, string> = {}): {
  ok: boolean;
  exit_code: number | null;
} {
  console.log(`\n>>> ${label}: npx tsx ${argv.join(" ")}`);
  const res = spawnSync("npx", ["tsx", ...argv], {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    shell: true,
    encoding: "utf8",
  });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  return { ok: res.status === 0, exit_code: res.status };
}

function readFetchUploadIds(fetchRunId: string, backfill: boolean): { order: string | null; shipment: string | null } {
  const bases = backfill
    ? [
        ".cursor/audit-reports/removal-9-month-backfill-fetch-chunk1",
        ".cursor/audit-reports/sp-api-removal-reports-fetch-execute",
      ]
    : [".cursor/audit-reports/sp-api-removal-reports-fetch-execute"];
  for (const base of bases) {
    const p = path.join(process.cwd(), base, fetchRunId, "manifest.json");
    if (!fs.existsSync(p)) continue;
    const m = JSON.parse(fs.readFileSync(p, "utf8")) as { upload_ids?: string[] };
    if (m.upload_ids?.length) {
      return { order: m.upload_ids[0] ?? null, shipment: m.upload_ids[1] ?? null };
    }
  }
  return { order: null, shipment: null };
}

function argValue(prefix: string): string | null {
  const a = process.argv.find((x) => x.startsWith(prefix));
  return a ? a.split("=")[1]!.trim() : null;
}

function chunksToRun(): GapChunk[] {
  const skip = new Set((argValue("--skip-chunks=") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const from = argValue("--from-chunk=");
  let chunks = GAP_CHUNKS.filter((c) => !skip.has(c.key));
  if (from) {
    const idx = chunks.findIndex((c) => c.key === from);
    if (idx >= 0) chunks = chunks.slice(idx);
  }
  return chunks;
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
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}.`);

  const fetchOk =
    readFlag(".cursor/operator-approvals/sp-api-removal-shipment-fetch-approval.md", "APPROVED_TO_RUN_STAGING") &&
    readFlag(".cursor/operator-approvals/sp-api-removal-shipment-fetch-approval.md", "APPROVED_SP_API_REMOVAL_SHIPMENT_FETCH");
  const backfillFetchOk =
    readFlag(".cursor/operator-approvals/removal-9-month-backfill-fetch-approval.md", "APPROVED_TO_RUN_STAGING") &&
    readFlag(".cursor/operator-approvals/removal-9-month-backfill-fetch-approval.md", "APPROVED_REMOVAL_9_MONTH_BACKFILL_FETCH");
  const syncOk =
    readFlag(".cursor/operator-approvals/sp-api-removal-reports-domain-sync-approval.md", "APPROVED_TO_RUN_STAGING") &&
    readFlag(".cursor/operator-approvals/sp-api-removal-reports-domain-sync-approval.md", "APPROVED_SP_API_REMOVAL_REPORTS_DOMAIN_SYNC");
  const resolverOk =
    readFlag(".cursor/operator-approvals/removal-expected-packages-resolver-backfill-approval.md", "APPROVED_TO_RUN_STAGING") &&
    readFlag(".cursor/operator-approvals/removal-expected-packages-resolver-backfill-approval.md", "APPROVED_REMOVAL_EXPECTED_PACKAGES_RESOLVER_BACKFILL");

  if (!syncOk) blockers.push("Domain sync approval not ready.");
  if (!resolverOk) blockers.push("Resolver approval not ready.");
  if (!fetchOk) blockers.push("SP-API fetch approval not ready.");
  if (!backfillFetchOk) blockers.push("9-month backfill fetch approval not ready.");

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const dbRef =
    refFromSupabaseUrl(dbUrl) ?? dbUrl.match(/\.([a-z]{20})\./)?.[1]?.toLowerCase() ?? null;
  if (!dbUrl || dbRef !== STAGING_REF) blockers.push(`STAGING_DIRECT_POSTGRES_URL must target ${STAGING_REF}.`);
  if (refFromSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "") === ORIGINAL_REF) {
    blockers.push("Original ref forbidden.");
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) blockers.push("SUPABASE_SERVICE_ROLE_KEY unset.");

  if (blockers.length) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.map((b) => `- ${b}`).join("\n") + "\n");
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ run_id: runId, status: "BLOCKED", blockers }, null, 2));
    console.log(JSON.stringify({ ok: false, blockers }, null, 2));
    process.exit(1);
  }

  process.env.ENABLE_AMAZON_REPORTS_API_WORKER = "true";
  process.env.ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER = "true";
  process.env.ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT = "true";
  process.env.ENABLE_IMPORT_DESCRIPTOR_METADATA = "true";

  const before = await snapshot();
  fs.writeFileSync(path.join(outDir, "before-snapshot.json"), JSON.stringify(before, null, 2));

  const chunks = chunksToRun();
  if (!apply) {
    fs.writeFileSync(
      path.join(outDir, "gap-plan.json"),
      JSON.stringify({ chunks, before }, null, 2),
    );
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify({ run_id: runId, status: "DRY_RUN_PASS", chunks: chunks.length }, null, 2),
    );
    console.log(JSON.stringify({ ok: true, mode: "dry-run", outDir, chunks: chunks.length }, null, 2));
    return;
  }

  const chunkResults: Record<string, unknown>[] = [];
  const execBlockers: string[] = [];

  for (const chunk of chunks) {
    const chunkRunId = `${runId}-${chunk.key}`;
    let orderUploadId = chunk.order_upload_id ?? null;
    let shipmentUploadId = chunk.shipment_upload_id ?? null;

    if (chunk.fetch) {
      const fetchRunId = `${chunkRunId}-fetch`;
      const fetchRes = runCmd(`fetch ${chunk.key}`, [
        "scripts/sp-api-removal-reports-fetch-execute.ts",
        `--run-id=${fetchRunId}`,
        "--backfill-9month",
        `--window-start=${chunk.window_start}`,
        `--window-end=${chunk.window_end}`,
      ]);
      const ids = readFetchUploadIds(fetchRunId, true);
      orderUploadId = ids.order;
      shipmentUploadId = ids.shipment;
      if (!fetchRes.ok || !orderUploadId || !shipmentUploadId) {
        execBlockers.push(`${chunk.key}: fetch failed or missing upload IDs`);
        chunkResults.push({ key: chunk.key, fetch: fetchRes, orderUploadId, shipmentUploadId });
        break;
      }
    }

    const syncRunId = `${chunkRunId}-sync`;
    const syncRes = runCmd(
      `domain sync ${chunk.key}`,
      [
        "scripts/sp-api-removal-reports-domain-sync-execute.ts",
        "--apply",
        `--run-id=${syncRunId}`,
        `--order-upload-id=${orderUploadId}`,
        `--shipment-upload-id=${shipmentUploadId}`,
      ],
      {
        REMOVAL_AUTOMATION_ORDER_UPLOAD_ID: orderUploadId!,
        REMOVAL_AUTOMATION_SHIPMENT_UPLOAD_ID: shipmentUploadId!,
      },
    );

    chunkResults.push({
      key: chunk.key,
      label: chunk.label,
      window: chunk.fetch ? { start: chunk.window_start, end: chunk.window_end } : "sync-only",
      order_upload_id: orderUploadId,
      shipment_upload_id: shipmentUploadId,
      sync_ok: syncRes.ok,
      sync_exit: syncRes.exit_code,
    });

    if (!syncRes.ok) {
      execBlockers.push(`${chunk.key}: domain sync failed (exit ${syncRes.exit_code})`);
      break;
    }
  }

  let allocationValid = false;
  let verifyRes: { ok: boolean; exit_code: number | null } = { ok: false, exit_code: null };

  if (execBlockers.length) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), execBlockers.map((b) => `- ${b}`).join("\n") + "\n");
  } else {
    const verifyRunId = `${runId}-verify`;
    verifyRes = runCmd("allocation verify", [
      "scripts/removal-quantity-allocation-validation.ts",
      `--run-id=${verifyRunId}`,
    ]);

    let verifyManifest: Record<string, unknown> = {};
    const verifyManifestPath = path.join(
      process.cwd(),
      ".cursor/audit-reports/removal-quantity-allocation-validation",
      verifyRunId,
      "manifest.json",
    );
    if (fs.existsSync(verifyManifestPath)) {
      verifyManifest = JSON.parse(fs.readFileSync(verifyManifestPath, "utf8")) as Record<string, unknown>;
    }

    allocationValid =
      verifyManifest.allocation_contract_valid === true ||
      Number(verifyManifest.live_vs_sim_non_overflow_mismatch ?? 1) === 0;

    if (!allocationValid || !verifyRes.ok) {
      execBlockers.push("verify gate failed — resolver skipped");
    } else {
      const lastChunk = chunkResults[chunkResults.length - 1] as { key?: string } | undefined;
      const lastSyncRun = lastChunk?.key ? `${runId}-${lastChunk.key}-sync` : null;
      const resolverRes = runCmd("resolver reconcile", [
        "scripts/removal-post-sync-resolver-reconcile.ts",
        "--apply",
        `--run-id=${runId}-resolver`,
      ], {
        REMOVAL_VERIFY_MANIFEST: `.cursor/audit-reports/removal-quantity-allocation-validation/${verifyRunId}/manifest.json`,
        REMOVAL_DOMAIN_SYNC_MANIFEST: lastSyncRun
          ? `.cursor/audit-reports/sp-api-removal-reports-domain-sync-execute/${lastSyncRun}/manifest.json`
          : "",
      });
      if (!resolverRes.ok) execBlockers.push("resolver reconcile failed");
    }
  }

  const after = await snapshot();
  fs.writeFileSync(path.join(outDir, "after-snapshot.json"), JSON.stringify(after, null, 2));

  const dbClient = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await dbClient.connect();
  const mismatchBreakdown = await queryEpAllocationMismatchBreakdown(dbClient, ORG_ID, STORE_ID);
  await dbClient.end();
  const rebuildValid = rebuildValidFromBreakdown(mismatchBreakdown);

  const deltas = {
    raw_uploads: after.raw_uploads - before.raw_uploads,
    removals: after.removals - before.removals,
    shipments: after.shipments - before.shipments,
    derived_ep: after.derived_ep - before.derived_ep,
    ep_resolved: after.ep_resolved - before.ep_resolved,
    ep_unresolved: after.ep_unresolved - before.ep_unresolved,
  };

  const dupOk =
    after.removal_staging_dup_groups === 0 &&
    after.upload_idempotency_dup_keys <= before.upload_idempotency_dup_keys + 4 &&
    after.products === before.products &&
    after.pim === before.pim;

  const status =
    execBlockers.length === 0 && rebuildValid && allocationValid && dupOk ? "PASS" : "FAIL";

  fs.writeFileSync(path.join(outDir, "chunk-results.json"), JSON.stringify(chunkResults, null, 2));
  fs.writeFileSync(path.join(outDir, "deltas.json"), JSON.stringify(deltas, null, 2));
  fs.writeFileSync(
    path.join(outDir, "removal-staging-gap-fetch-sync.md",
    ),
    [
      "# REMOVAL-STAGING-GAP-FETCH-SYNC",
      "",
      `Run: \`${runId}\` · Status: **${status}** · Branch: \`${branch}\``,
      "",
      "## Date ranges processed",
      "",
      ...chunkResults.map((c) => {
        const w = c.window as { start?: string; end?: string } | string;
        const range =
          typeof w === "object" && w?.start
            ? `\`${String(w.start).slice(0, 10)}\` → \`${String(w.end).slice(0, 10)}\``
            : "sync-only (Sep pending uploads)";
        return `- **${c.key}**: ${range} — sync ${c.sync_ok ? "PASS" : "FAIL"}`;
      }),
      "",
      "## Deltas",
      "",
      "| Metric | Before | After | Δ |",
      "|--------|-------:|------:|--:|",
      `| amazon_removals | ${before.removals} | ${after.removals} | ${deltas.removals} |`,
      `| amazon_removal_shipments | ${before.shipments} | ${after.shipments} | ${deltas.shipments} |`,
      `| expected_packages (derived) | ${before.derived_ep} | ${after.derived_ep} | ${deltas.derived_ep} |`,
      `| EP resolved | ${before.ep_resolved} | ${after.ep_resolved} | ${deltas.ep_resolved} |`,
      `| EP unresolved | ${before.ep_unresolved} | ${after.ep_unresolved} | ${deltas.ep_unresolved} |`,
      `| raw_report_uploads | ${before.raw_uploads} | ${after.raw_uploads} | ${deltas.raw_uploads} |`,
      "",
      "## Verify gate",
      "",
      `| non_overflow mismatch | ${mismatchBreakdown.non_overflow} |`,
      `| overflow mismatch | ${mismatchBreakdown.overflow} |`,
      `| rebuild_valid | **${rebuildValid ? "yes" : "no"}** |`,
      `| allocation_contract_valid | **${allocationValid ? "yes" : "no"}** |`,
      "",
      "## Duplicate prevention",
      "",
      `| Probe | Before | After | OK |`,
      `|-------|-------:|------:|:---:|`,
      `| staging dup groups | ${before.removal_staging_dup_groups} | ${after.removal_staging_dup_groups} | ${after.removal_staging_dup_groups === 0 ? "yes" : "no"} |`,
      `| products | ${before.products} | ${after.products} | ${after.products === before.products ? "yes" : "no"} |`,
      `| product_identifier_map | ${before.pim} | ${after.pim} | ${after.pim === before.pim ? "yes" : "no"} |`,
      "",
      "## Blockers",
      "",
      execBlockers.length ? execBlockers.map((b) => `- ${b}`).join("\n") : "- None",
      "",
      "## Cron / apply",
      "",
      "**Scheduled cron apply not enabled** (by design).",
      "",
      status === "PASS"
        ? "Next: `REMOVAL-DAILY-AUTOMATION-APPLY-BURNIN-STAGING --skip-fetch` full pipeline smoke, then consider workflow_dispatch apply after `gh` + secret gate."
        : "Next: fix blockers above, then re-run gap sync or allocation fix.",
    ].join("\n") + "\n",
  );

  if (execBlockers.length) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), execBlockers.map((b) => `- ${b}`).join("\n") + "\n");
  }

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "REMOVAL-STAGING-GAP-FETCH-SYNC",
        run_id: runId,
        status,
        staging_ref: STAGING_REF,
        deltas,
        mismatch_breakdown: mismatchBreakdown,
        rebuild_valid: rebuildValid,
        duplicate_check: dupOk ? "PASS" : "REVIEW",
        cron_apply_enabled: false,
        chunk_results: chunkResults,
        exec_blockers: execBlockers,
      },
      null,
      2,
    ),
  );

  console.log(JSON.stringify({ ok: status === "PASS", outDir, status, deltas }, null, 2));
  process.exit(status === "PASS" ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
