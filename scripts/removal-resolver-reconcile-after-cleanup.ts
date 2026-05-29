/**
 * REMOVAL RESOLVER RECONCILE AFTER CLEANUP — dry-run + optional execute.
 *
 * Reconciles resolver columns on clean derived expected_packages after allocation fix.
 *
 *   npx tsx scripts/removal-resolver-reconcile-after-cleanup.ts --run-id=<UTC_Z>
 *   npx tsx scripts/removal-resolver-reconcile-after-cleanup.ts --run-id=<UTC_Z> --execute
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  parseRemovalRawDataHints,
  resolveExpectedPackageProduct,
  type RemovalExpectedPackageRow,
} from "../lib/removal/resolve-expected-package-product";
import type { ScannerResolutionColumns } from "../lib/scanner-product-resolve";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/removal-resolver-reconcile-after-cleanup";
const APPROVAL_PATH = ".cursor/operator-approvals/removal-expected-packages-resolver-backfill-approval.md";
const ALLOCATION_FIX = ".cursor/audit-reports/removal-rebuild-allocation-fix-execute/20260528T181500Z/manifest.json";
const VERIFY_PASS = ".cursor/audit-reports/removal-rebuild-verify-and-resolver-dryrun/20260528T181500Z-verify/manifest.json";
const DERIVED_SOURCES = ["detail_shipment", "detail_remainder"] as const;

type BackfillProposal = {
  id: string;
  organization_id: string;
  store_id: string | null;
  order_id: string | null;
  build_source: string | null;
  bucket: string;
  hints: {
    sku: string | null;
    fnsku: string | null;
    asin: string | null;
    upc: string | null;
  };
  before: {
    resolved_product_id: string | null;
    resolved_catalog_product_id: string | null;
    identifier_resolution_status: string | null;
    identifier_resolution_confidence: number | null;
  };
  after: ScannerResolutionColumns;
  apply_kind: "set_resolved" | "status_only" | "skip_unchanged";
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
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

function readApproval(): { approved: boolean; runStaging: boolean; backfill: boolean } {
  const p = path.join(process.cwd(), APPROVAL_PATH);
  if (!fs.existsSync(p)) return { approved: false, runStaging: false, backfill: false };
  const text = fs.readFileSync(p, "utf8");
  const runStaging = /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text);
  const backfill = /APPROVED_REMOVAL_EXPECTED_PACKAGES_RESOLVER_BACKFILL\s*=\s*true/i.test(text);
  return { approved: runStaging && backfill, runStaging, backfill };
}

function loadJson<T>(rel: string): T | null {
  const p = path.join(process.cwd(), rel);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

async function probeCounts(client: pg.Client): Promise<Record<string, unknown>> {
  const r = await client.query(
    `SELECT
      COUNT(*)::bigint AS derived_total,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::bigint AS resolved,
      COUNT(*) FILTER (WHERE identifier_resolution_status = 'resolved')::bigint AS status_resolved,
      COUNT(*) FILTER (WHERE identifier_resolution_status = 'ambiguous')::bigint AS ambiguous,
      COUNT(*) FILTER (
        WHERE resolved_product_id IS NULL
          AND (identifier_resolution_status IS NULL OR identifier_resolution_status = 'unresolved')
      )::bigint AS unresolved_or_null
    FROM public.expected_packages
    WHERE build_source = ANY($1::text[])`,
    [DERIVED_SOURCES],
  );
  return r.rows[0] as Record<string, unknown>;
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
       AND organization_id IS NOT NULL AND store_id IS NOT NULL
       AND id > $1::uuid
     ORDER BY id LIMIT $2`,
    [cursor, limit, DERIVED_SOURCES],
  );
  return res.rows as RemovalExpectedPackageRow[];
}

async function fetchRemovalHydration(client: pg.Client, detailIds: string[]) {
  const out = new Map<string, { asin: string | null; upc: string | null }>();
  const CHUNK = 500;
  for (let i = 0; i < detailIds.length; i += CHUNK) {
    const slice = detailIds.slice(i, i + CHUNK);
    const r = await client.query(
      `SELECT id::text, raw_data FROM public.amazon_removals WHERE id = ANY($1::uuid[])`,
      [slice],
    );
    for (const row of r.rows) {
      out.set(String(row.id), parseRemovalRawDataHints(row.raw_data));
    }
  }
  return out;
}

async function productExists(client: pg.Client, productId: string): Promise<boolean> {
  const r = await client.query(`SELECT 1 FROM public.products WHERE id = $1::uuid LIMIT 1`, [productId]);
  return r.rows.length > 0;
}

async function buildProposals(
  supabase: ReturnType<typeof createClient>,
  pgClient: pg.Client,
  rows: RemovalExpectedPackageRow[],
  hydration: Map<string, { asin: string | null; upc: string | null }>,
): Promise<BackfillProposal[]> {
  const out: BackfillProposal[] = [];
  for (const row of rows) {
    const before = {
      resolved_product_id: n(row.resolved_product_id),
      resolved_catalog_product_id: n(row.resolved_catalog_product_id),
      identifier_resolution_status: n(row.identifier_resolution_status),
      identifier_resolution_confidence: num(row.identifier_resolution_confidence),
    };
    const detailId = n(row.source_detail_row_id);
    const removalHints = detailId ? hydration.get(detailId) : undefined;
    const resolved = await resolveExpectedPackageProduct(supabase, row, {
      asinFromRemoval: removalHints?.asin ?? null,
      upcFromRemoval: removalHints?.upc ?? null,
    });

    let after: ScannerResolutionColumns = { ...resolved.columns };
    let apply_kind: BackfillProposal["apply_kind"] = "status_only";

    if (after.identifier_resolution_status === "resolved" && after.resolved_product_id) {
      if (await productExists(pgClient, after.resolved_product_id)) apply_kind = "set_resolved";
      else {
        after = {
          ...after,
          resolved_product_id: null,
          resolved_catalog_product_id: null,
          identifier_resolution_status: "unresolved",
        };
      }
    } else {
      after = {
        resolved_product_id: null,
        resolved_catalog_product_id: null,
        identifier_resolution_status: after.identifier_resolution_status,
        identifier_resolution_confidence: after.identifier_resolution_confidence,
      };
    }

    const unchanged =
      before.resolved_product_id === after.resolved_product_id &&
      before.resolved_catalog_product_id === after.resolved_catalog_product_id &&
      before.identifier_resolution_status === after.identifier_resolution_status &&
      before.identifier_resolution_confidence === after.identifier_resolution_confidence;
    if (unchanged) apply_kind = "skip_unchanged";

    out.push({
      id: row.id,
      organization_id: row.organization_id,
      store_id: n(row.store_id),
      order_id: n(row.order_id),
      build_source: n(row.build_source),
      bucket: resolved.bucket,
      hints: {
        sku: resolved.hints.sku,
        fnsku: resolved.hints.fnsku,
        asin: resolved.hints.asin,
        upc: resolved.hints.upc,
      },
      before,
      after,
      apply_kind,
    });
  }
  return out;
}

async function applyProposals(client: pg.Client, proposals: BackfillProposal[]): Promise<number> {
  let applied = 0;
  for (const p of proposals.filter((x) => x.apply_kind !== "skip_unchanged")) {
    if (p.apply_kind === "set_resolved") {
      const r = await client.query(
        `UPDATE public.expected_packages t
         SET resolved_product_id = $2::uuid,
             resolved_catalog_product_id = $3::uuid,
             identifier_resolution_status = $4,
             identifier_resolution_confidence = $5,
             updated_at = now()
         FROM public.products pr
         WHERE t.id = $1::uuid AND pr.id = $2::uuid
         RETURNING t.id::text`,
        [
          p.id,
          p.after.resolved_product_id,
          p.after.resolved_catalog_product_id,
          p.after.identifier_resolution_status,
          p.after.identifier_resolution_confidence,
        ],
      );
      if (r.rowCount) applied += 1;
    } else {
      const r = await client.query(
        `UPDATE public.expected_packages
         SET resolved_product_id = NULL,
             resolved_catalog_product_id = NULL,
             identifier_resolution_status = $2,
             identifier_resolution_confidence = $3,
             updated_at = now()
         WHERE id = $1::uuid
         RETURNING id::text`,
        [p.id, p.after.identifier_resolution_status, p.after.identifier_resolution_confidence],
      );
      if (r.rowCount) applied += 1;
    }
  }
  return applied;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const execute = hasFlag("--execute");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const approval = readApproval();
  const blockers: string[] = [];

  const allocFix = loadJson<{
    status: string;
    rebuild_valid: boolean;
    mismatch_count_after: number;
    verify_run_id: string;
  }>(ALLOCATION_FIX);
  const verify = loadJson<{
    status: string;
    rebuild_valid: boolean;
    ep_mismatch_vs_simulation: number;
    expected_packages_derived_count: number;
    resolver_resolved_count: number;
    resolver_missing_evidence_count: number;
  }>(VERIFY_PASS);

  if (!allocFix || allocFix.status !== "PASS") blockers.push("allocation-fix execute PASS required");
  if (!verify || verify.status !== "PASS" || !verify.rebuild_valid) {
    blockers.push("rebuild verify PASS with rebuild_valid=yes required");
  }
  if (verify && verify.ep_mismatch_vs_simulation !== 0) {
    blockers.push(`mismatch count must be 0 (got ${verify.ep_mismatch_vs_simulation})`);
  }
  if (execute && !approval.approved) {
    blockers.push(
      "Execute blocked: set APPROVED_TO_RUN_STAGING=true and APPROVED_REMOVAL_EXPECTED_PACKAGES_RESOLVER_BACKFILL=true",
    );
  }

  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  const publicUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const ref = refFromSupabaseUrl(publicUrl) || refFromSupabaseUrl(dbUrl);
  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    blockers.push(`Staging ref guard failed (expected ${STAGING_REF})`);
  }

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof",
      "",
      `| Flag | Value |`,
      `|------|-------|`,
      `| APPROVED_TO_RUN_STAGING | ${approval.runStaging} |`,
      `| APPROVED_REMOVAL_EXPECTED_PACKAGES_RESOLVER_BACKFILL | ${approval.backfill} |`,
      `| Execute allowed | ${approval.approved && execute ? "yes" : "no"} |`,
      "",
      `File: \`${APPROVAL_PATH}\``,
    ].join("\n") + "\n",
  );

  if (blockers.some((b) => b.includes("Staging ref") || b.includes("allocation-fix") || b.includes("rebuild verify") || b.includes("mismatch"))) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.map((b) => `- ${b}`).join("\n") + "\n");
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify({ prompt: "REMOVAL-RESOLVER-RECONCILE-AFTER-CLEANUP", run_id: runId, status: "BLOCKED", blockers }, null, 2),
    );
    console.log(JSON.stringify({ status: "BLOCKED", blockers, outDir }, null, 2));
    process.exit(2);
  }

  const pgClient = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();
  await pgClient.query(`SET statement_timeout = '600s'`);
  const preCounts = await probeCounts(pgClient);

  const supabase = createClient(
    publicUrl,
    process.env.STAGING_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "",
    { auth: { persistSession: false } },
  );

  const allProposals: BackfillProposal[] = [];
  let cursor = "00000000-0000-0000-0000-000000000000";
  const PAGE = 500;
  for (;;) {
    const batch = await fetchCandidateRows(pgClient, cursor, PAGE);
    if (!batch.length) break;
    const detailIds = [
      ...new Set(batch.map((r) => n(r.source_detail_row_id)).filter((x): x is string => !!x)),
    ];
    const hydration = await fetchRemovalHydration(pgClient, detailIds);
    allProposals.push(...(await buildProposals(supabase, pgClient, batch, hydration)));
    cursor = batch[batch.length - 1]!.id;
    if (batch.length < PAGE) break;
  }

  const summary = {
    candidates_scanned: allProposals.length,
    set_resolved: allProposals.filter((p) => p.apply_kind === "set_resolved").length,
    status_only: allProposals.filter((p) => p.apply_kind === "status_only").length,
    skip_unchanged: allProposals.filter((p) => p.apply_kind === "skip_unchanged").length,
    queue_resolved: allProposals.filter((p) => p.bucket === "resolved").length,
    queue_missing_evidence: allProposals.filter((p) => p.bucket === "missing_product_needs_evidence").length,
    queue_ambiguous: allProposals.filter((p) => p.bucket === "ambiguous").length,
  };

  const toApply = allProposals.filter((p) => p.apply_kind !== "skip_unchanged");
  const unresolvedEvidence = allProposals
    .filter((p) => p.bucket === "missing_product_needs_evidence")
    .map((p) => ({
      expected_package_id: p.id,
      order_id: p.order_id,
      sku: p.hints.sku,
      fnsku: p.hints.fnsku,
      asin: p.hints.asin,
      build_source: p.build_source,
      identifier_resolution_status: p.after.identifier_resolution_status,
    }));

  const preimageRows = toApply.map((p) => ({
    id: p.id,
    old_resolved_product_id: p.before.resolved_product_id,
    old_resolved_catalog_product_id: p.before.resolved_catalog_product_id,
    old_identifier_resolution_status: p.before.identifier_resolution_status,
    old_identifier_resolution_confidence: p.before.identifier_resolution_confidence,
  }));

  const rollbackSql = preimageRows.map((r) => {
    const rp = r.old_resolved_product_id === null ? "NULL" : `'${r.old_resolved_product_id}'::uuid`;
    const rc = r.old_resolved_catalog_product_id === null ? "NULL" : `'${r.old_resolved_catalog_product_id}'::uuid`;
    const st = r.old_identifier_resolution_status === null ? "NULL" : `'${r.old_identifier_resolution_status}'`;
    const conf = r.old_identifier_resolution_confidence === null ? "NULL" : String(r.old_identifier_resolution_confidence);
    return `UPDATE public.expected_packages SET resolved_product_id=${rp}, resolved_catalog_product_id=${rc}, identifier_resolution_status=${st}, identifier_resolution_confidence=${conf}, updated_at=now() WHERE id='${r.id}'::uuid;`;
  });

  fs.writeFileSync(
    path.join(outDir, "resolver-dryrun-clean.md"),
    [
      "# Resolver dry-run (clean derived set)",
      "",
      `| Metric | Value |`,
      `|--------|------:|`,
      `| Derived total (live pre) | ${preCounts.derived_total} |`,
      `| Candidates scanned | ${summary.candidates_scanned} |`,
      `| Resolved (dry-run) | ${summary.queue_resolved} |`,
      `| Missing evidence | ${summary.queue_missing_evidence} |`,
      `| Ambiguous | ${summary.queue_ambiguous} |`,
      `| set_resolved proposals | ${summary.set_resolved} |`,
      `| status_only (clear stale) | ${summary.status_only} |`,
      `| skip_unchanged | ${summary.skip_unchanged} |`,
      "",
      `Verify baseline: \`${VERIFY_PASS}\``,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(path.join(outDir, "unresolved-evidence-needed.json"), JSON.stringify(unresolvedEvidence, null, 2));

  let applied = 0;
  let appliedRows: BackfillProposal[] = [];

  if (execute && approval.approved) {
    applied = await applyProposals(pgClient, allProposals);
    appliedRows = toApply;
  }

  const postCounts = execute && approval.approved ? await probeCounts(pgClient) : null;
  await pgClient.end();

  fs.writeFileSync(
    path.join(outDir, "applied-rows.json"),
    JSON.stringify(
      {
        executed: execute && approval.approved,
        applied_count: applied,
        rows: appliedRows.map((p) => ({
          id: p.id,
          apply_kind: p.apply_kind,
          before: p.before,
          after: p.after,
          bucket: p.bucket,
        })),
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(outDir, "rollback.sql"),
    ["-- REMOVAL-RESOLVER-RECONCILE-AFTER-CLEANUP rollback", ...rollbackSql].join("\n"),
    "utf8",
  );

  const nextPrompt =
    execute && approval.approved
      ? "PC03D-EVIDENCE-QUEUE-FROM-REMOVAL-RESOLVER — refresh Amazon evidence queue for post-cleanup missing_product_needs_evidence rows"
      : "REMOVAL-RESOLVER-RECONCILE-AFTER-CLEANUP-EXECUTE — set both approval flags true and rerun with --execute";

  const status = execute && !approval.approved ? "BLOCKED" : "PASS";

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length
      ? blockers.map((b) => `- ${b}`).join("\n") + "\n"
      : execute && !approval.approved
        ? "- Execute blocked pending approval flags.\n"
        : "# Blockers\n\nNone.\n",
  );

  const manifest = {
    prompt: "REMOVAL-RESOLVER-RECONCILE-AFTER-CLEANUP",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    status,
    execute_attempted: execute,
    approval,
    preconditions: {
      allocation_fix: ALLOCATION_FIX,
      verify_pass: VERIFY_PASS,
      rebuild_valid: verify?.rebuild_valid ?? false,
      mismatch_count: verify?.ep_mismatch_vs_simulation ?? null,
    },
    clean_derived_total: Number(preCounts.derived_total ?? summary.candidates_scanned),
    ...summary,
    applied,
    pre_counts: preCounts,
    post_counts: postCounts,
    exact_next_prompt: nextPrompt,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(JSON.stringify(manifest, null, 2));
  if (status === "BLOCKED") process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
