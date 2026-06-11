/**
 * PHASE-MENORIX-CLAIM-CENTER-SHELL staging smoke — zero writes.
 *   npx tsx scripts/phase-claim-center-v1-read-staging-smoke.ts
 *
 * Verifies read-model handlers, module gate, Menorix shell artifacts, and no mutation paths.
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Module } from "node:module";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/phase-claim-center-v1-read-staging-smoke";
const ORG = "7397edff-7994-4731-8501-55d258d507d2";

const CLAIM_CENTER_ROUTES = [
  "app/claim-center/page.tsx",
  "app/claim-center/opportunities/page.tsx",
  "app/claim-center/candidates/page.tsx",
  "app/claim-center/review/page.tsx",
  "app/claim-center/evidence/page.tsx",
  "app/claim-center/references/page.tsx",
  "app/claim-center/product-linkage/page.tsx",
  "app/claim-center/cases/page.tsx",
  "app/claim-center/submissions/page.tsx",
  "app/claim-center/recovery/page.tsx",
  "app/claim-center/runs/page.tsx",
  "app/claim-center/settings/page.tsx",
];

const MENORIX_COMPONENTS = [
  "components/menorix/MenorixModuleAppShell.tsx",
  "components/menorix/MenorixModuleCommandHome.tsx",
  "components/menorix/MenorixModuleTileGrid.tsx",
  "components/menorix/MenorixModuleKpiStrip.tsx",
  "components/menorix/MenorixModuleScopeBar.tsx",
  "components/menorix/MenorixModuleSectionTabs.tsx",
  "components/menorix/MenorixModuleDetailDrawer.tsx",
  "components/menorix/MenorixModuleEmptyState.tsx",
  "components/menorix/MenorixModuleFeatureLockedCard.tsx",
  "components/menorix/MenorixModuleAiAssistCard.tsx",
  "components/menorix/MenorixModuleAutomationHealthCard.tsx",
];

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
}

async function countWritesBeforeAfter(admin: SupabaseClient): Promise<{ candidates: number; edges: number; submissions: number; cases: number }> {
  const [c, e, s, cases] = await Promise.all([
    admin.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", ORG),
    admin.from("claim_reference_edges").select("id", { count: "exact", head: true }).eq("organization_id", ORG),
    admin.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG),
    admin.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG),
  ]);
  return {
    candidates: c.count ?? 0,
    edges: e.count ?? 0,
    submissions: s.count ?? 0,
    cases: cases.count ?? 0,
  };
}

function staticChecks(): Record<string, boolean> {
  const root = process.cwd();
  const routesOk = CLAIM_CENTER_ROUTES.every((r) => fs.existsSync(path.join(root, r)));
  const menorixOk = MENORIX_COMPONENTS.every((r) => fs.existsSync(path.join(root, r)));
  const mobileCardsOk = fs.existsSync(path.join(root, "components/claim-center/ClaimCenterMobileCards.tsx"));
  const legacyUntouched = !fs.readFileSync(path.join(root, "app/claim-engine/inbox/ClaimInboxClient.tsx"), "utf8").includes("MenorixModuleAppShell");
  return {
    claim_center_routes_present: routesOk,
    menorix_components_present: menorixOk,
    mobile_card_component_present: mobileCardsOk,
    legacy_claim_engine_not_patched: legacyUntouched,
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const url = process.env.STAGING_SUPABASE_URL?.trim() || "";
  const key = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || "";
  if (refFromSupabaseUrl(url) !== STAGING_REF) {
    throw new Error(`Expected staging ref ${STAGING_REF}`);
  }
  const admin = createClient(url, key, { auth: { persistSession: false } });

  const {
    getCenterDashboardPayload,
    getCenterOpportunitiesPayload,
    getCenterReviewPayload,
    getCenterReferencesPayload,
    getCenterProductLinkagePayload,
    getCenterRecoveryPayload,
    getCenterRunsPayload,
    getCenterSubmissionsPayload,
    fetchCenterCandidateRows,
    getCenterModuleAccessPayload,
    getCenterAiAccessPayload,
    getCenterAutomationHealthPayload,
  } = await import("../lib/claims/center/claim-center-api-handlers");

  const { evaluateMenorixAiModuleAccess } = await import("../lib/menorix/evaluate-menorix-ai-module-access");

  const static_ok = staticChecks();
  const before = await countWritesBeforeAfter(admin);
  const checks: Record<string, unknown> = {};

  checks.static = static_ok;
  checks.module_access = await getCenterModuleAccessPayload(ORG);
  checks.dashboard = await getCenterDashboardPayload(ORG, null);
  checks.opportunities = await getCenterOpportunitiesPayload(ORG, null, 20);
  checks.review = await getCenterReviewPayload(ORG, null, 20);
  checks.references = await getCenterReferencesPayload(ORG, null, null, 20);
  checks.product_linkage = await getCenterProductLinkagePayload(ORG, null, 20);
  checks.recovery = await getCenterRecoveryPayload(ORG, null, 20);
  checks.runs = await getCenterRunsPayload(ORG, null);
  checks.submissions = await getCenterSubmissionsPayload(ORG, null, 20);
  checks.inbox_center_v1 = await fetchCenterCandidateRows(ORG, { storeId: null, limit: 25 });
  checks.ai_access = await getCenterAiAccessPayload(ORG);
  checks.automation_health = await getCenterAutomationHealthPayload(ORG, null);
  checks.ai_gate_direct = await evaluateMenorixAiModuleAccess(admin, ORG);

  const after = await countWritesBeforeAfter(admin);
  const zero_writes =
    before.candidates === after.candidates &&
    before.edges === after.edges &&
    before.submissions === after.submissions &&
    before.cases === after.cases;

  const allStatic = Object.values(static_ok).every(Boolean);
  const moduleEnabled = !!(checks.module_access as { enabled?: boolean }).enabled;
  const aiStates = new Set(["locked", "setup_required", "ready"]);
  const aiOk = aiStates.has(String((checks.ai_access as { state?: string }).state));

  const runId = stamp();
  const outDir = path.join(OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });
  const summary = {
    audit: "PHASE-MENORIX-CLAIM-CENTER-SHELL-STAGING-SMOKE",
    run_id: runId,
    organization_id: ORG,
    zero_writes,
    static_checks_pass: allStatic,
    module_gate_ok: moduleEnabled,
    ai_gate_ok: aiOk,
    counts_before: before,
    counts_after: after,
    routes_exercised: Object.keys(checks).filter((k) => k !== "static"),
    safe_to_push: zero_writes && allStatic && moduleEnabled && aiOk,
  };
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ summary, checks }, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Menorix Claim Center shell smoke\n\n- zero_writes: **${zero_writes}**\n- static: **${allStatic}**\n- module: **${moduleEnabled}**\n- ai_gate: **${aiOk}**\n`,
  );
  console.log(JSON.stringify(summary, null, 2));
  if (!zero_writes || !allStatic) process.exit(1);
  if (!moduleEnabled) {
    console.warn("WARN: module gate disabled for smoke org — safe_to_push may be no until claim_recovery enabled.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
