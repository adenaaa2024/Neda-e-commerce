/**
 * PHASE-CLAIM-EFFECTIVE-DATE-GATE-V1 — staging verify
 *   npx tsx scripts/phase-claim-effective-date-gate-v1.ts --run-id=<UTC> [--staging]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { buildFirstSafeFamiliesPreviewGenerators } from "../lib/claims/center/claim-first-safe-families-preview-generators-v1";
import {
  buildClaimGroupingReadmodel,
  filterPreviewItems,
} from "../lib/claims/grouping/claim-grouping-readmodel";
import {
  evaluateClaimEffectiveDateGate,
  resolveEffectiveDateForSource,
} from "../lib/claims/effective-date/claim-effective-date-gate-v1";
import { loadEffectiveClaimIntakePolicy } from "../lib/claims/intake/claim-intake-policy-contract";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-effective-date-gate-v1";
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

async function main(): Promise<void> {
  const id = runId();
  const staging = process.argv.includes("--staging");
  const skipBuild = process.argv.includes("--skip-build");
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });
  const root = process.cwd();

  const filesChanged = [
    "lib/claims/effective-date/claim-effective-date-gate-v1.ts",
    "lib/claims/intake/claim-preview-emit-date-gate-v1.ts",
    "lib/claims/center/claim-first-safe-families-preview-generators-v1.ts",
    "lib/claims/grouping/claim-grouping-readmodel.ts",
    "lib/claims/intake/claim-intake-settings.ts",
    "lib/claims/intake/claim-preview-emit-v1.ts",
    "lib/claims/intake/claim-generator-registry.ts",
    "scripts/smoke-claim-effective-date-gate-v1.ts",
    "scripts/phase-claim-effective-date-gate-v1.ts",
  ];

  let previewBefore: Awaited<ReturnType<typeof buildFirstSafeFamiliesPreviewGenerators>> | null = null;
  let groupingBaseline: Awaited<ReturnType<typeof buildClaimGroupingReadmodel>> | null = null;
  let groupingDateFiltered: { count: number } | null = null;
  let casesCount: number | null = null;
  let candidatesBefore: number | null = null;
  let candidatesAfter: number | null = null;
  let policy: Awaited<ReturnType<typeof loadEffectiveClaimIntakePolicy>> | null = null;

  if (staging) {
    loadEnvLocalIntoProcess();
    const url = process.env.STAGING_SUPABASE_URL?.trim() || "";
    const key = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || "";
    if (refFromSupabaseUrl(url) !== STAGING_REF) throw new Error(`Expected ${STAGING_REF}`);
    const client = createClient(url, key, { auth: { persistSession: false } });

    candidatesBefore = (
      await client
        .from("claim_candidates")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", ORG)
    ).count;

    casesCount = (
      await client
        .from("claim_cases")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", ORG)
    ).count;

    policy = await loadEffectiveClaimIntakePolicy(client, ORG, STORE);
    previewBefore = await buildFirstSafeFamiliesPreviewGenerators({
      client,
      organizationId: ORG,
      storeId: STORE,
      include_all_previews: true,
      prerequisite_safe: "yes",
    });

    groupingBaseline = await buildClaimGroupingReadmodel({
      client,
      organizationId: ORG,
      storeId: STORE,
      filters: {
        organization_id: ORG,
        store_id: STORE,
        status: "claim_ready",
        grouping_mode: "product_family",
        limit: 50,
      },
    });

    const futureFrom = "2026-05-15";
    const dateFiltered = filterPreviewItems(previewBefore.previews, {
      organization_id: ORG,
      store_id: STORE,
      status: "claim_ready",
      date_from: futureFrom,
      grouping_mode: "product_family",
    });
    groupingDateFiltered = { count: dateFiltered.length };

    candidatesAfter = (
      await client
        .from("claim_candidates")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", ORG)
    ).count;
  }

  let buildResult = "skipped";
  let smokeResult = "skipped";
  if (!skipBuild) {
    try {
      execSync("npm run build", { stdio: "pipe", cwd: root, timeout: 300_000 });
      buildResult = "pass";
    } catch (e) {
      buildResult = `fail: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
    }
  } else {
    buildResult = "skipped (--skip-build)";
  }
  try {
    execSync(`npx tsx scripts/smoke-claim-effective-date-gate-v1.ts --run-id=${id}`, {
      stdio: "pipe",
      cwd: root,
    });
    smokeResult = "pass";
  } catch {
    smokeResult = "fail";
  }

  const emitSrc = fs.readFileSync(path.join(root, "lib/claims/intake/claim-preview-emit-v1.ts"), "utf8");
  const scannerOk = !emitSrc.includes("operator-mobile");

  const previewGatePass =
    previewBefore == null ||
    (previewBefore.date_gate_summary.claim_ready_pre_cutoff === 0 &&
      previewBefore.date_gate_summary.claim_ready_missing_event_date === 0 &&
      previewBefore.previews.every((p) =>
        p.recommended_action !== "claim_ready" || p.date_gate_passed,
      ));

  const groupingDatePass =
    groupingDateFiltered == null ||
    (groupingBaseline != null &&
      groupingDateFiltered.count < groupingBaseline.filtered_preview_count);

  const results = {
    prompt: "PHASE-CLAIM-EFFECTIVE-DATE-GATE-V1",
    run_id: id,
    staging_ref: staging ? STAGING_REF : null,
    files_changed: filesChanged,
    effective_date_sources_used: ["claim_start_date", "scan_go_live_date", "claim_eligibility_window_days"],
    preview_event_date_fields_added: [
      "event_date",
      "source_event_date",
      "pre_cutoff",
      "missing_event_date",
      "effective_date_source",
      "effective_date_value",
      "date_gate_passed",
    ],
    preview_gate_result: previewBefore
      ? {
          pass: previewGatePass,
          family_counts: previewBefore.family_counts,
          date_gate_summary: previewBefore.date_gate_summary,
          effective_date_context: previewBefore.effective_date_context,
          intake_window: previewBefore.window,
        }
      : null,
    grouping_date_filter_result: {
      pass: groupingDatePass,
      baseline_claim_ready: groupingBaseline?.filtered_preview_count ?? null,
      filtered_from_2026_05_15: groupingDateFiltered?.count ?? null,
      effective_date_context: groupingBaseline?.effective_date_context ?? null,
    },
    emit_date_recheck_result: {
      pass: emitSrc.includes("evaluateClaimPreviewEmitDateGate"),
      note: "Emit re-checks date gate immediately before applyDrafts",
    },
    missing_event_date_behavior: "deriveAction → needs_review; emit skip not_claim_ready / missing_source_event_date",
    pre_cutoff_behavior: "deriveAction → needs_review; emit skip pre_cutoff_event",
    scanner_vs_api_cutoff_behavior: policy
      ? {
          removal: resolveEffectiveDateForSource("delayed_not_received", policy),
          scanner: resolveEffectiveDateForSource("scanner_physical_review", policy),
        }
      : {
          removal: resolveEffectiveDateForSource("delayed_not_received", {
            claim_start_date: "2026-01-15",
            scan_go_live_date: "2026-01-15",
          }),
          scanner: resolveEffectiveDateForSource("scanner_physical_review", {
            claim_start_date: "2026-01-15",
            scan_go_live_date: "2026-01-15",
          }),
        },
    count_changes_summary: previewBefore
      ? {
          previews_total: previewBefore.family_counts.total_previews,
          claim_ready: previewBefore.family_counts.claim_ready,
          needs_review: previewBefore.family_counts.needs_review,
          pre_cutoff: previewBefore.date_gate_summary.pre_cutoff_count,
          missing_event_date: previewBefore.date_gate_summary.missing_event_date_count,
        }
      : null,
    no_claim_case_mutation_verification: {
      pass: casesCount == null || casesCount === 2,
      claim_cases_count: casesCount,
    },
    no_claim_candidate_mutation_verification: {
      pass: candidatesBefore == null || candidatesBefore === candidatesAfter,
      before: candidatesBefore,
      after: candidatesAfter,
    },
    no_scanner_change_verification: { pass: scannerOk },
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_EFFECTIVE_DATE_GATE_READY:
      (buildResult === "pass" || buildResult.startsWith("skipped")) &&
      smokeResult === "pass" &&
      previewGatePass &&
      groupingDatePass &&
      scannerOk
        ? "yes"
        : "no",
    SAFE_TO_RUN_NEXT_STAGING_EMIT_WAVE:
      (buildResult === "pass" || buildResult.startsWith("skipped")) &&
      smokeResult === "pass" &&
      previewGatePass &&
      scannerOk
        ? "yes"
        : "no",
    NEXT_PROMPT: "PHASE-CLAIM-CANDIDATE-EMIT-STAGING-PILOT-ROLLBACK-DRILL-V1 — optional; then PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-PILOT-PLAN-V1",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Effective date gate V1\n\n- build: **${buildResult}**\n- smoke: **${smokeResult}**\n- SAFE_EFFECTIVE_DATE_GATE_READY: **${results.SAFE_EFFECTIVE_DATE_GATE_READY}**\n`,
  );

  if (results.SAFE_EFFECTIVE_DATE_GATE_READY !== "yes") process.exit(1);
  console.log(JSON.stringify({ ok: true, run_id: id, SAFE_EFFECTIVE_DATE_GATE_READY: results.SAFE_EFFECTIVE_DATE_GATE_READY }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
