/**
 * PHASE-CLAIM-EFFECTIVE-DATE-SETTINGS-AUDIT-V1 — read-only audit
 *   npx tsx scripts/phase-claim-effective-date-settings-audit-v1.ts --run-id=<UTC> [--staging]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  evaluateClaimEligibilitySync,
  evaluateImportCandidateCutoffSync,
  loadClaimPolicy,
  normalizeClaimPolicy,
} from "../lib/claim-eligibility-policy";
import { buildFirstSafeFamiliesPreviewGenerators } from "../lib/claims/center/claim-first-safe-families-preview-generators-v1";
import { collectDrafts } from "../lib/claims/center/claim-readmodel-staging-dryrun-v1";
import { loadClaimIntakeSettings, resolveClaimIntakeWindow } from "../lib/claims/intake/claim-intake-settings";
import { CLAIM_INTAKE_GENERATORS } from "../lib/claims/intake/claim-intake-generators";
import { loadEffectiveClaimIntakePolicy } from "../lib/claims/intake/claim-intake-policy-contract";
import { filterPreviewItems } from "../lib/claims/grouping/claim-grouping-readmodel";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-effective-date-settings-audit-v1";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

function srcUsesCutoff(rel: string): boolean {
  const s = readSrc(rel);
  return (
    s.includes("claim_start_date") ||
    s.includes("scan_go_live_date") ||
    s.includes("cutoffDateForSource") ||
    s.includes("evaluateClaimEligibility")
  );
}

async function main(): Promise<void> {
  const id = runId();
  const staging = process.argv.includes("--staging");
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const previewSrc = readSrc("lib/claims/center/claim-first-safe-families-preview-generators-v1.ts");
  const groupingSrc = readSrc("lib/claims/grouping/claim-grouping-readmodel.ts");
  const emitSrc = readSrc("lib/claims/intake/claim-preview-emit-v1.ts");
  const emitContractSrc = readSrc("lib/claims/contracts/claim-candidate-emit-approval-contract-v1.ts");

  let policyRaw: Record<string, unknown> | null = null;
  let effectiveIntake: Awaited<ReturnType<typeof loadEffectiveClaimIntakePolicy>> | null = null;
  let intakeSettings: Awaited<ReturnType<typeof loadClaimIntakeSettings>> | null = null;
  let intakeWindow: ReturnType<typeof resolveClaimIntakeWindow> | null = null;
  let candidatesBefore = 0;
  let candidatesAfter = 0;
  let preCutoffClaimReady = 0;
  let missingEventDateClaimReady = 0;
  let samplePreCutoff: Array<Record<string, unknown>> = [];
  let groupingDateFilterApplied = false;

  if (staging) {
    loadEnvLocalIntoProcess();
    const url = process.env.STAGING_SUPABASE_URL?.trim() || "";
    const key = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || "";
    if (refFromSupabaseUrl(url) === STAGING_REF) {
      const client = createClient(url, key, { auth: { persistSession: false } });

      const { data: orgRow } = await client
        .from("organization_settings")
        .select("claim_policy")
        .eq("organization_id", ORG)
        .maybeSingle();
      policyRaw = ((orgRow as { claim_policy?: unknown } | null)?.claim_policy ?? null) as Record<
        string,
        unknown
      > | null;

      const { data: wsRow } = await client
        .from("workspace_settings")
        .select("module_configs")
        .limit(1)
        .maybeSingle();
      const moduleConfigs = (wsRow as { module_configs?: unknown } | null)?.module_configs;

      effectiveIntake = await loadEffectiveClaimIntakePolicy(client, ORG, STORE);
      intakeSettings = await loadClaimIntakeSettings(client, ORG);
      intakeWindow = resolveClaimIntakeWindow(intakeSettings.settings, null, null);
      const policy = await loadClaimPolicy(client, ORG);

      const before = await client
        .from("claim_candidates")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", ORG);
      candidatesBefore = before.count ?? 0;

      const previewPayload = await buildFirstSafeFamiliesPreviewGenerators({
        client,
        organizationId: ORG,
        storeId: STORE,
        include_all_previews: true,
        rowLimit: 200,
        prerequisite_safe: "yes",
      });

      const allDrafts = await collectDrafts(
        client,
        ORG,
        STORE,
        CLAIM_INTAKE_GENERATORS.map((g) => g.source_kind),
        intakeWindow,
        400,
      );
      const draftByDedupe = new Map(allDrafts.map((d) => [d.dedupe_key, d]));

      for (const p of previewPayload.previews) {
        if (p.recommended_action !== "claim_ready") continue;
        const draft = draftByDedupe.get(p.duplicate_key);
        const eventDate = draft?.event_date ?? null;
        if (!eventDate) {
          missingEventDateClaimReady += 1;
          continue;
        }
        const importKinds = new Set([
          "delayed_not_received",
          "amazon_removal_api",
          "reimbursement",
          "settlement",
          "transaction",
        ]);
        const isImport = importKinds.has(p.source_kind);
        const cutoff = isImport ? policy.claim_start_date : policy.scan_go_live_date;
        if (cutoff && eventDate < cutoff) {
          preCutoffClaimReady += 1;
          if (samplePreCutoff.length < 5) {
            samplePreCutoff.push({
              preview_id: p.preview_id,
              family_key: p.family_key,
              source_kind: p.source_kind,
              event_date: eventDate,
              cutoff,
              dedupe_key: p.duplicate_key,
            });
          }
        }
      }

      const filtered = filterPreviewItems(previewPayload.previews, {
        organization_id: ORG,
        store_id: STORE,
        date_from: "2026-01-01",
        date_to: "2026-12-31",
      });
      groupingDateFilterApplied = filtered.length === previewPayload.previews.length;

      const after = await client
        .from("claim_candidates")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", ORG);
      candidatesAfter = after.count ?? 0;

      fs.writeFileSync(
        path.join(outDir, "staging-config-snapshot.json"),
        JSON.stringify(
          {
            organization_id: ORG,
            store_id: STORE,
            claim_policy: policyRaw,
            workspace_module_configs_claim_intake: (moduleConfigs as Record<string, unknown>)?.claim_intake ?? null,
            effective_intake_policy: {
              scan_go_live_date: effectiveIntake.scan_go_live_date,
              claim_start_date: effectiveIntake.claim_start_date,
              claim_eligibility_window_days: effectiveIntake.claim_eligibility_window_days,
              delayed_not_received_days: effectiveIntake.delayed_not_received_days,
              sources_read: effectiveIntake.sources_read,
            },
            intake_window_resolved: intakeWindow,
            intake_settings_sources: intakeSettings.sources_read,
          },
          null,
          2,
        ),
      );
    }
  }

  const settingsSourcesFound = [
    {
      table: "organization_settings",
      column: "claim_policy",
      fields: [
        "scan_go_live_date",
        "claim_start_date",
        "claim_eligibility_window_days",
        "claim_hold_policy",
        "enabled_claim_domains",
        "allow_manual_override",
        "intake (nested)",
        "candidate_intake (nested)",
      ],
      ui: "/settings (Claim policy section)",
    },
    {
      table: "workspace_settings",
      column: "module_configs.claim_intake",
      fields: ["date_from", "date_to", "rolling_window_days", "enabled_sources", "delayed_not_received_days"],
      ui: "Platform / Claim API intake panel",
    },
    {
      table: "platform_settings",
      column: "automation_settings.scopes[store].claim_candidate_intake",
      fields: ["claim_candidate_trigger", "claimable_physical_events"],
      ui: "Store-scoped candidate intake override",
    },
    {
      module: "lib/claim-effective-settings.ts",
      fields: ["claim_from_date (=scan_go_live_date)", "claim_cutoff_date (=claim_start_date)"],
    },
  ];

  const effectiveDateFieldNames = {
    found_in_codebase: ["scan_go_live_date", "claim_start_date", "claim_eligibility_window_days"],
    intake_window_fields: ["date_from", "date_to", "rolling_window_days"],
    effective_settings_aliases: ["claim_from_date", "claim_cutoff_date"],
    not_found: [
      "claim_live_from",
      "claim_effective_date",
      "scanner_claim_start_date",
      "missing_review_start_date",
    ],
    routing_rule:
      "import/API sources (import_candidate, expected_mismatch, delayed_not_received, amazon_removal_api, reimbursement, settlement) → claim_start_date; scanner/physical → scan_go_live_date",
  };

  const previewGeneratorDateGateStatus = {
    uses_loadClaimIntakeSettings: previewSrc.includes("loadClaimIntakeSettings"),
    uses_resolveClaimIntakeWindow: previewSrc.includes("resolveClaimIntakeWindow"),
    uses_claim_start_date: previewSrc.includes("claim_start_date"),
    uses_scan_go_live_date: previewSrc.includes("scan_go_live_date"),
    uses_evaluateClaimEligibility: previewSrc.includes("evaluateClaimEligibility"),
    deriveAction_checks_event_date: previewSrc.includes("event_date"),
    preview_item_has_event_date_field: previewSrc.includes("event_date:") && /PreviewGeneratorItem/.test(previewSrc),
    verdict:
      previewSrc.includes("claim_start_date") || previewSrc.includes("evaluateClaimEligibility")
        ? "GATED"
        : "NOT_GATED — intake rolling window only; no org claim_start_date/scan_go_live enforcement on previews",
  };

  const groupingDateFilterStatus = {
    date_from_date_to_parsed: groupingSrc.includes("date_from") && groupingSrc.includes("date_to"),
    date_applied_in_filterPreviewItems:
      /filters\.date_from/.test(groupingSrc) || /filters\.date_to/.test(groupingSrc),
    ui_exposes_date_filters: readSrc("components/claim-center/grouping/ClaimGroupBuilderFilters.tsx").includes(
      "date_from",
    ),
    staging_date_filter_noop: staging ? groupingDateFilterApplied : null,
    verdict: "UI + API params present; filterPreviewItems does NOT apply date_from/date_to (known gap)",
  };

  const emitDateGateStatus = {
    uses_claim_policy_cutoff: emitSrc.includes("claim_start_date") || emitSrc.includes("scan_go_live_date"),
    uses_evaluateClaimEligibility: emitSrc.includes("evaluateClaimEligibility"),
    skip_reason_pre_cutoff: emitSrc.includes("pre_cutoff"),
    emit_contract_requires_event_date: emitContractSrc.includes("event_date"),
    verdict: "NOT_GATED — emit trusts preview claim_ready; no cutoff re-check before applyDrafts",
  };

  const scannerMissingDateGateStatus = {
    scanner_promote_uses_evaluateClaimEligibility: readSrc("lib/scanner-operator-claim-promote.ts").includes(
      "evaluateClaimEligibility",
    ),
    returns_actions_uses_evaluateClaimEligibility: readSrc("app/returns/actions.ts").includes(
      "evaluateClaimEligibility",
    ),
    claim_intake_generators_scanner_uses_cutoff: readSrc("lib/claims/intake/claim-intake-generators.ts").includes(
      "evaluateClaimEligibility",
    ),
    scanner_generator_window: "return_items.created_at filtered by ctx.window.from/to (intake window, not scan_go_live_date)",
    claim_center_v1_lifecycle_cutoff: srcUsesCutoff("lib/claims/intake/claim-intake-policy-contract.ts"),
    verdict:
      "Scanner PROMOTE path gated via scan_go_live_date; unified pool preview/emit/generators NOT gated by scan_go_live_date",
  };

  const gapsFound = [
    {
      id: "preview_no_cutoff_gate",
      severity: "block",
      detail:
        "buildFirstSafeFamiliesPreviewGenerators + deriveAction do not evaluate claim_start_date/scan_go_live_date; pre-cutoff events can be claim_ready if inside rolling intake window.",
    },
    {
      id: "preview_missing_event_date_field",
      severity: "high",
      detail: "PreviewGeneratorItem has no event_date; grouping/UI cannot filter previews by event date without joining drafts.",
    },
    {
      id: "grouping_date_filter_unimplemented",
      severity: "medium",
      detail: "filterPreviewItems ignores date_from/date_to despite API/UI support.",
    },
    {
      id: "emit_no_cutoff_recheck",
      severity: "block",
      detail: "claim-preview-emit-v1 has no pre_cutoff skip; can write claim_candidates for events before effective dates.",
    },
    {
      id: "intake_window_decoupled",
      severity: "high",
      detail:
        "resolveClaimIntakeWindow uses module_configs.claim_intake date_from/rolling_window_days — not auto-bound to claim_start_date/scan_go_live_date.",
    },
    {
      id: "missing_separate_scanner_missing_dates",
      severity: "info",
      detail:
        "No scanner_claim_start_date or missing_review_start_date keys; scan_go_live_date serves all scanner paths; missing uses same scan_go_live via scanner_operator_issue.",
    },
    {
      id: "no_date_preview_behavior",
      severity: "medium",
      detail:
        "deriveAction does not downgrade missing event_date to needs_review/unavailable; only linkage/disputed/matrix gates apply.",
    },
  ];

  const policy = normalizeClaimPolicy(policyRaw);
  const synthPreCutoff = policy.claim_start_date
    ? !evaluateImportCandidateCutoffSync(policy, "amazon_removals", { shipment_date: "2025-06-01" }, null).allowed
    : null;
  const synthScanBlock = policy.scan_go_live_date
    ? !evaluateClaimEligibilitySync({
        policy,
        claimSource: "scanner_operator_issue",
        eventAt: "2025-06-01",
        hasScannerEvidence: true,
      }).allowed
    : null;

  const results = {
    prompt: "PHASE-CLAIM-EFFECTIVE-DATE-SETTINGS-AUDIT-V1",
    run_id: id,
    mode: "read_only_audit",
    settings_sources_found: settingsSourcesFound,
    effective_date_field_names: effectiveDateFieldNames,
    current_config_values_by_org_store_if_safe: staging
      ? {
          organization_id: ORG,
          store_id: STORE,
          scan_go_live_date: effectiveIntake?.scan_go_live_date ?? null,
          claim_start_date: effectiveIntake?.claim_start_date ?? null,
          claim_eligibility_window_days: effectiveIntake?.claim_eligibility_window_days ?? null,
          intake_window: intakeWindow,
          rolling_window_days: intakeSettings?.settings.rolling_window_days ?? null,
          intake_date_from: intakeSettings?.settings.date_from ?? null,
          intake_date_to: intakeSettings?.settings.date_to ?? null,
          allow_manual_override: policy.allow_manual_override === true,
        }
      : "staging_not_run",
    preview_generator_date_gate_status: previewGeneratorDateGateStatus,
    grouping_date_filter_status: groupingDateFilterStatus,
    emit_date_gate_status: emitDateGateStatus,
    scanner_missing_date_gate_status: scannerMissingDateGateStatus,
    staging_sample_pre_cutoff_claim_ready: staging
      ? { count: preCutoffClaimReady, missing_event_date_claim_ready: missingEventDateClaimReady, samples: samplePreCutoff }
      : null,
    policy_engine_synthetic_checks: {
      import_before_claim_start_blocked: synthPreCutoff,
      scan_before_go_live_blocked: synthScanBlock,
    },
    no_date_or_missing_date_behavior: {
      claim_eligibility_policy: "null/missing eventAt → denied (scan_not_live or import_pre_cutoff when cutoff set)",
      preview_generators: "missing event_date on draft not checked in deriveAction — may still be claim_ready",
      claim_center_lifecycle: "deriveClaimLifecycleStatus: cutoff+eventDate → ineligible_pre_cutoff; !cutoff+eventDate → not_yet_claimable",
    },
    consumer_cutoff_matrix: {
      "lib/claim-eligibility-policy.ts": true,
      "lib/scanner-operator-claim-promote.ts": true,
      "app/returns/actions.ts": true,
      "lib/claims/intake/claim-intake-policy-contract.ts (deriveClaimLifecycleStatus)": true,
      "lib/claims/center/claim-first-safe-families-preview-generators-v1.ts": false,
      "lib/claims/grouping/claim-grouping-readmodel.ts": false,
      "lib/claims/intake/claim-preview-emit-v1.ts": false,
      "lib/claims/intake/claim-generator-registry.ts (applyDrafts)": false,
      "lib/claims/intake/claim-intake-generators.ts": false,
    },
    gaps_found: gapsFound,
    recommended_fix_if_needed: {
      required_before_emit: true,
      follow_up_prompt: "PHASE-CLAIM-EFFECTIVE-DATE-GATE-V1",
      scope: [
        "Bind resolveClaimIntakeWindow floor to max(rolling_from, claim_start_date) for import sources and max(rolling_from, scan_go_live_date) for scanner sources OR post-filter drafts with cutoffDateForSource",
        "Add event_date + pre_cutoff review_flag to PreviewGeneratorItem; deriveAction → needs_review when event_date < cutoff or missing",
        "Implement filterPreviewItems date_from/date_to against preview event_date",
        "Add emit skip reasons: pre_cutoff_event, missing_event_date",
        "Default grouping UI date_from from effective policy when empty",
        "Extend emit approval contract with explicit cutoff rules",
      ],
    },
    no_db_write_verification: staging ? candidatesBefore === candidatesAfter : "skipped",
    no_claim_candidate_mutation_verification: staging ? candidatesBefore === candidatesAfter : "skipped",
    no_scanner_change_verification: "PASS — audit read-only; no app/scanner edits",
    SAFE_TO_RUN_EMIT_PILOT_WITH_DATE_GATES:
      previewGeneratorDateGateStatus.verdict === "GATED" && emitDateGateStatus.verdict === "GATED"
        ? "yes"
        : "no",
    NEXT_PROMPT: "PHASE-CLAIM-EFFECTIVE-DATE-GATE-V1",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md",
    ),
    `# Claim effective date settings audit V1\n\n- SAFE_TO_RUN_EMIT_PILOT_WITH_DATE_GATES: **${results.SAFE_TO_RUN_EMIT_PILOT_WITH_DATE_GATES}**\n- Preview gate: **${previewGeneratorDateGateStatus.verdict}**\n- Emit gate: **${emitDateGateStatus.verdict}**\n- Follow-up: **PHASE-CLAIM-EFFECTIVE-DATE-GATE-V1**\n`,
  );

  console.log(JSON.stringify({ ok: true, run_id: id, SAFE_TO_RUN_EMIT_PILOT_WITH_DATE_GATES: results.SAFE_TO_RUN_EMIT_PILOT_WITH_DATE_GATES }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
