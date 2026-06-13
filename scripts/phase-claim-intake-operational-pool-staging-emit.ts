/**
 * PHASE-CLAIM-INTAKE-OPERATIONAL-POOL-STAGING-EMIT
 * Staging-only trusted operational claim_candidates pool emit.
 *
 *   npx tsx scripts/phase-claim-intake-operational-pool-staging-emit.ts
 *   npx tsx scripts/phase-claim-intake-operational-pool-staging-emit.ts --dry-run-only
 */
import { createRequire } from "node:module";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Module } from "node:module";
import { execSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { CLAIM_INTAKE_GENERATORS } from "../lib/claims/intake/claim-intake-generators";
import { runClaimIntake } from "../lib/claims/intake/claim-generator-registry";
import {
  loadClaimIntakeSettings,
  resolveClaimIntakeWindow,
} from "../lib/claims/intake/claim-intake-settings";
import type { ClaimCandidateDraft, ClaimSourceKind } from "../lib/claims/intake/claim-intake-types";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const SMOKE_ORG = "7397edff-7994-4731-8501-55d258d507d2";
const DEFAULT_ORG = "00000000-0000-0000-0000-000000000001";
const OUT_BASE = ".cursor/audit-reports/phase-claim-intake-operational-pool-staging-emit";
const SCANNER_PREFIX = "app/scanner/operator-mobile/";
const DRY_RUN_ONLY = process.argv.includes("--dry-run-only");

/** Trusted operational generators — never legacy_seed. */
const OPERATIONAL_SOURCES: ClaimSourceKind[] = [
  "scanner_physical_review",
  "amazon_removal_api",
  "reimbursement",
  "settlement",
  "transaction",
  "inventory_ledger",
  "safet",
  "delayed_not_received",
  "shipment_discrepancy",
  "inbound_shipment",
  "orbit_fra",
];

const ACTIVE_FILTER = (q: ReturnType<SupabaseClient["from"]>) =>
  q.is("quarantined_at", null).neq("source_kind", "legacy_seed");

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
}

function scannerSnapshot(): string[] {
  try {
    const out = execSync(`git diff --name-only -- "${SCANNER_PREFIX}"`, {
      encoding: "utf8",
      cwd: process.cwd(),
    }).trim();
    return out ? out.split(/\r?\n/).filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function countActiveCandidates(client: SupabaseClient, orgId: string): Promise<number> {
  const { count, error } = await ACTIVE_FILTER(
    client.from("claim_candidates").select("id", { count: "exact", head: true }),
  )
    .eq("organization_id", orgId);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function tableCount(client: SupabaseClient, table: string, orgId: string): Promise<number> {
  const { count, error } = await client
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);
  if (error) return -1;
  return count ?? 0;
}

async function collectAllDrafts(
  client: SupabaseClient,
  organizationId: string,
  storeId: string | null,
  sources: ClaimSourceKind[],
  from: string,
  to: string,
  rowLimit: number,
): Promise<ClaimCandidateDraft[]> {
  const { settings } = await loadClaimIntakeSettings(client, organizationId);
  const window = resolveClaimIntakeWindow(settings, from, to);
  const drafts: ClaimCandidateDraft[] = [];
  const sourceSet = new Set(sources);

  for (const gen of CLAIM_INTAKE_GENERATORS) {
    if (!sourceSet.has(gen.source_kind)) continue;
    const output = await gen.generate({
      client,
      organizationId,
      storeId,
      window,
      settings,
      rowLimit,
      runKind: "manual",
    });
    drafts.push(...output.drafts);
  }
  return drafts;
}

function validateDrafts(drafts: ClaimCandidateDraft[]): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!drafts.length) errors.push("dry_run_drafts_zero");
  for (const d of drafts) {
    if (d.source_kind === "legacy_seed") errors.push(`legacy_seed_draft:${d.dedupe_key}`);
    if (!d.organization_id) errors.push(`missing_org:${d.dedupe_key}`);
    if (!d.store_id) errors.push(`missing_store:${d.dedupe_key}`);
    if (d.organization_id !== SMOKE_ORG) errors.push(`wrong_org:${d.organization_id}`);
  }
  return { ok: errors.length === 0, errors };
}

function summarizeDrafts(drafts: ClaimCandidateDraft[]) {
  const bySource: Record<string, number> = {};
  const byFamily: Record<string, number> = {};
  const byStore: Record<string, number> = {};
  for (const d of drafts) {
    bySource[d.source_kind] = (bySource[d.source_kind] ?? 0) + 1;
    byFamily[d.claim_family] = (byFamily[d.claim_family] ?? 0) + 1;
    const sid = d.store_id ?? "null";
    byStore[sid] = (byStore[sid] ?? 0) + 1;
  }
  return { bySource, byFamily, byStore };
}

async function postApplyBreakdown(client: SupabaseClient, orgId: string, runId: string) {
  const { data, error } = await ACTIVE_FILTER(
    client
      .from("claim_candidates")
      .select("source_kind, claim_family, candidate_status, store_id")
      .eq("organization_id", orgId)
      .eq("intake_run_id", runId),
  );
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{
    source_kind: string;
    claim_family: string;
    candidate_status: string;
    store_id: string | null;
  }>;
  const bySource: Record<string, number> = {};
  const byFamily: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const byStore: Record<string, number> = {};
  for (const r of rows) {
    bySource[r.source_kind] = (bySource[r.source_kind] ?? 0) + 1;
    byFamily[r.claim_family] = (byFamily[r.claim_family] ?? 0) + 1;
    byStatus[r.candidate_status] = (byStatus[r.candidate_status] ?? 0) + 1;
    byStore[r.store_id ?? "null"] = (byStore[r.store_id ?? "null"] ?? 0) + 1;
  }
  return { total: rows.length, bySource, byFamily, byStatus, byStore, rows };
}

async function claimCenterApiSample(client: SupabaseClient, orgId: string) {
  const { getCenterDashboardPayload, fetchCenterCandidateRows } = await import(
    "../lib/claims/center/claim-center-api-handlers"
  );
  const dashboard = await getCenterDashboardPayload(orgId, null);
  const rows = await fetchCenterCandidateRows(orgId, { storeId: null, limit: 5 });
  return {
    kpis: dashboard.kpis,
    meta: dashboard.meta,
    opportunity_count: dashboard.opportunities.length,
    sample_rows: rows.slice(0, 3).map((r) => ({
      id: r.id,
      source_kind: r.source_kind,
      claim_family: r.claim_family,
      v1_status_group: r.v1_status_group,
      evidence_status: r.evidence_status,
      reference_edge_count: r.reference_edge_count,
    })),
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const stagingUrl = process.env.STAGING_SUPABASE_URL?.trim() ?? "";
  const serviceKey = process.env.STAGING_SERVICE_ROLE_KEY?.trim() ?? "";
  const stagingRef = refFromSupabaseUrl(stagingUrl);

  if (stagingRef !== STAGING_REF) {
    throw new Error(`Refusing: expected staging ref ${STAGING_REF}, got ${stagingRef ?? "null"}`);
  }
  if (process.env.ORIGINAL_PROJECT_REF && refFromSupabaseUrl(process.env.ORIGINAL_SUPABASE_URL ?? "") === stagingRef) {
    throw new Error("Refusing: staging URL matches original/live guard.");
  }

  const client = createClient(stagingUrl, serviceKey, { auth: { persistSession: false } });
  const runId = crypto.randomUUID();
  const scannerBefore = scannerSnapshot();

  // ── 1) Preflight ─────────────────────────────────────────────────────────
  const { data: stores } = await client
    .from("stores")
    .select("id, name")
    .eq("organization_id", SMOKE_ORG);
  const storeIds = (stores ?? []).map((s) => String(s.id));

  const preflight = {
    target_env: "staging",
    staging_ref: STAGING_REF,
    smoke_org_id: SMOKE_ORG,
    stores_checked: stores ?? [],
    active_candidates_smoke_before: await countActiveCandidates(client, SMOKE_ORG),
    active_candidates_default_org: await countActiveCandidates(client, DEFAULT_ORG),
    legacy_seed_default_org: await client
      .from("claim_candidates")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", DEFAULT_ORG)
      .eq("source_kind", "legacy_seed")
      .then((r) => r.count ?? 0),
    return_items_smoke: await client
      .from("return_items")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", SMOKE_ORG)
      .is("deleted_at", null)
      .then((r) => r.count ?? 0),
    claim_cases_before: await tableCount(client, "claim_cases", SMOKE_ORG),
    claim_submissions_before: await tableCount(client, "claim_submissions", SMOKE_ORG),
    amazon_reimbursements: await tableCount(client, "amazon_reimbursements", SMOKE_ORG),
  };

  if (preflight.active_candidates_smoke_before !== 0) {
    throw new Error(`Preflight failed: smoke org already has ${preflight.active_candidates_smoke_before} active candidates`);
  }
  if (preflight.return_items_smoke < 1) {
    throw new Error("Preflight failed: no return_items on smoke org");
  }

  const { settings } = await loadClaimIntakeSettings(client, SMOKE_ORG);
  const window = resolveClaimIntakeWindow(settings, null, null);
  const rowLimit = Math.min(settings.per_run_row_limit, 50);

  // ── 2) Dry run ───────────────────────────────────────────────────────────
  const drySummary = await runClaimIntake({
    client,
    organizationId: SMOKE_ORG,
    storeId: null,
    sources: OPERATIONAL_SOURCES,
    from: window.from,
    to: window.to,
    apply: false,
    rowLimit,
    runId,
    runKind: "manual",
  });

  const allDrafts = await collectAllDrafts(
    client,
    SMOKE_ORG,
    null,
    OPERATIONAL_SOURCES,
    window.from,
    window.to,
    rowLimit,
  );
  const draftSummary = summarizeDrafts(allDrafts);
  const validation = validateDrafts(allDrafts);

  const skippedRows = drySummary.results
    .filter((r) => !r.ran || r.drafts_generated === 0)
    .map((r) => ({
      source_kind: r.source_kind,
      skip_reason: r.skip_reason ?? (r.ran ? "zero_matches" : "not_ran"),
      matched: r.matched_count,
      notes: r.notes,
      error: r.error,
    }));

  const dry_run_summary = {
    run_id: runId,
    window: drySummary.window,
    operational_sources: OPERATIONAL_SOURCES,
    totals: drySummary.totals,
    per_source: drySummary.results.map((r) => ({
      source_kind: r.source_kind,
      ran: r.ran,
      matched: r.matched_count,
      drafts: r.drafts_generated,
      legacy_overlap: r.legacy_overlap_count,
      skip_reason: r.skip_reason,
      error: r.error,
    })),
    expected_by_source_kind: draftSummary.bySource,
    expected_by_claim_family: draftSummary.byFamily,
    expected_by_store_id: draftSummary.byStore,
    attachment_readiness: {
      evidence_status_on_insert: "missing (default per generator apply)",
      trid_edges: allDrafts.some((d) => d.reference_edges.length > 0)
        ? "reference_edges in metadata — materialize via phase7h post-apply"
        : "no reference edges on drafts",
      product_linkage: allDrafts.filter((d) => d.product.resolved_product_id).length,
      unresolved_product: allDrafts.filter((d) => !d.product.resolved_product_id).length,
    },
    validation,
    skipped_rows: skippedRows,
  };

  // ── 3) Approval gate ─────────────────────────────────────────────────────
  let apply_executed = false;
  let applyOutcome: Awaited<ReturnType<typeof runClaimIntake>> | null = null;
  const gateErrors: string[] = [...validation.errors];

  if (allDrafts.length === 0) gateErrors.push("abort:dry_run_zero_drafts");
  if (allDrafts.some((d) => d.source_kind === "legacy_seed")) gateErrors.push("abort:legacy_seed_draft");
  if (allDrafts.some((d) => !d.organization_id)) gateErrors.push("abort:missing_organization_id");
  if (allDrafts.some((d) => !d.store_id)) gateErrors.push("abort:missing_store_id");

  const gateClean = gateErrors.length === 0;

  if (gateClean && !DRY_RUN_ONLY) {
    applyOutcome = await runClaimIntake({
      client,
      organizationId: SMOKE_ORG,
      storeId: null,
      sources: OPERATIONAL_SOURCES,
      from: window.from,
      to: window.to,
      apply: true,
      rowLimit,
      runId,
      runKind: "manual",
    });
    apply_executed = true;
  }

  const scannerAfter = scannerSnapshot();

  // ── 5) Post-run ──────────────────────────────────────────────────────────
  const activeAfter = await countActiveCandidates(client, SMOKE_ORG);
  const legacyUsed = await client
    .from("claim_candidates")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", SMOKE_ORG)
    .eq("source_kind", "legacy_seed");
  const quarantinedUsed = await client
    .from("claim_candidates")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", SMOKE_ORG)
    .not("quarantined_at", "is", null);

  const postBreakdown = apply_executed
    ? await postApplyBreakdown(client, SMOKE_ORG, runId)
    : { total: 0, bySource: {}, byFamily: {}, byStatus: {}, byStore: {}, rows: [] };

  let claim_center_api_sample: unknown = null;
  if (apply_executed && activeAfter > 0) {
    try {
      claim_center_api_sample = await claimCenterApiSample(client, SMOKE_ORG);
    } catch (e) {
      claim_center_api_sample = { error: e instanceof Error ? e.message : String(e) };
    }
  }

  let build_result: { ok: boolean; error?: string } = { ok: false, error: "not_run" };
  if (apply_executed) {
    try {
      execSync("npm run build", { cwd: process.cwd(), encoding: "utf8", stdio: "pipe", timeout: 300000 });
      build_result = { ok: true };
    } catch (e) {
      build_result = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  let smoke_result: { ok: boolean; error?: string } = { ok: false, error: "not_run" };
  if (apply_executed) {
    try {
      execSync("npx tsx scripts/phase-claim-center-v1-read-staging-smoke.ts", {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: "pipe",
        timeout: 120000,
      });
      smoke_result = { ok: true };
    } catch (e) {
      smoke_result = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  const report = {
    run_id: stamp(),
    target_env: "staging",
    staging_ref: STAGING_REF,
    smoke_org_id: SMOKE_ORG,
    stores_checked: preflight.stores_checked,
    preflight_counts: preflight,
    dry_run_summary,
    apply_executed,
    gate_clean: gateClean,
    gate_errors: gateErrors,
    candidates_created: applyOutcome?.totals.inserted ?? 0,
    candidates_by_source_kind: postBreakdown.bySource,
    candidates_by_claim_family: postBreakdown.byFamily,
    candidates_by_status: postBreakdown.byStatus,
    candidates_by_store: postBreakdown.byStore,
    active_candidates_after: activeAfter,
    skipped_rows: skippedRows,
    legacy_seed_used_must_be_false: (legacyUsed.count ?? 0) === 0,
    quarantined_used_must_be_false: (quarantinedUsed.count ?? 0) === 0,
    scanner_files_changed_must_be_empty: [...new Set([...scannerBefore, ...scannerAfter])],
    claim_cases_count_before_after: [preflight.claim_cases_before, await tableCount(client, "claim_cases", SMOKE_ORG)],
    claim_submissions_count_before_after: [
      preflight.claim_submissions_before,
      await tableCount(client, "claim_submissions", SMOKE_ORG),
    ],
    claim_center_api_sample,
    build_result,
    smoke_result,
    apply_outcome: applyOutcome
      ? { totals: applyOutcome.totals, per_source: applyOutcome.results.map((r) => ({ source_kind: r.source_kind, apply: r.apply })) }
      : null,
    SAFE_TO_EVALUATE_CLAIM_CENTER_UI_ON_REAL_DATA:
      apply_executed && activeAfter > 0 && (legacyUsed.count ?? 0) === 0 ? "yes_with_warnings" : "no",
    NEXT_PROMPT: apply_executed
      ? "PHASE-CLAIM-CENTER-V2-SHELL-IMPLEMENT-READONLY"
      : "PHASE-CLAIM-INTAKE-OPERATIONAL-POOL-STAGING-EMIT-RETRY",
  };

  const outDir = path.join(process.cwd(), OUT_BASE, report.run_id);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "gate-report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, "summary.md"), renderSummary(report));

  console.log(JSON.stringify(report, null, 2));
  process.exit(gateClean && (DRY_RUN_ONLY || apply_executed) ? 0 : 1);
}

function renderSummary(r: Record<string, unknown>): string {
  return `# PHASE-CLAIM-INTAKE-OPERATIONAL-POOL-STAGING-EMIT

**Run:** ${r.run_id}
**Apply:** ${String(r.apply_executed)}
**Active candidates after:** ${(r as { active_candidates_after?: number }).active_candidates_after}
**SAFE_TO_EVALUATE:** ${r.SAFE_TO_EVALUATE_CLAIM_CENTER_UI_ON_REAL_DATA}
`;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
