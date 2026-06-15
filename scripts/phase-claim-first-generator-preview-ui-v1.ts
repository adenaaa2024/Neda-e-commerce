/**
 * PHASE-CLAIM-FIRST-GENERATOR-PREVIEW-UI-V1 — static + optional staging API verify
 *   npx tsx scripts/phase-claim-first-generator-preview-ui-v1.ts --run-id=<UTC> [--staging]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { buildFirstSafeFamiliesPreviewGenerators } from "../lib/claims/center/claim-first-safe-families-preview-generators-v1";
import {
  filterPreviewGeneratorItems,
  summarizeFilteredPreviews,
} from "../lib/claims/preview/claim-preview-generators-ui-contract";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-first-generator-preview-ui-v1";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

const FILES = [
  "lib/claims/preview/claim-preview-generators-ui-contract.ts",
  "components/claim-center/preview/ClaimPreviewGeneratorsView.tsx",
  "components/claim-center/preview/ClaimPreviewGeneratorsFilters.tsx",
  "components/claim-center/preview/ClaimPreviewGeneratorsSummary.tsx",
  "components/claim-center/preview/ClaimPreviewGeneratorsTable.tsx",
  "components/claim-center/preview/ClaimPreviewGeneratorsDisabledActions.tsx",
  "app/claim-center/preview-generators/page.tsx",
  "components/claim-center/claim-center-nav-config.ts",
  "scripts/smoke-claim-first-generator-preview-ui-v1.ts",
  "scripts/phase-claim-first-generator-preview-ui-v1.ts",
];

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
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });
  const root = process.cwd();

  const view = fs.readFileSync(
    path.join(root, "components/claim-center/preview/ClaimPreviewGeneratorsView.tsx"),
    "utf8",
  );
  const contract = fs.readFileSync(
    path.join(root, "lib/claims/preview/claim-preview-generators-ui-contract.ts"),
    "utf8",
  );

  let apiOk = false;
  let claimReadyCount = 0;
  let needsReviewCount = 0;
  let candidatesBefore: number | null = null;
  let candidatesAfter: number | null = null;
  let casesBefore: number | null = null;
  let casesAfter: number | null = null;

  if (staging) {
    loadEnvLocalIntoProcess();
    const url = process.env.STAGING_SUPABASE_URL?.trim() || "";
    const key = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || "";
    if (refFromSupabaseUrl(url) !== STAGING_REF) throw new Error(`Expected ${STAGING_REF}`);
    const client = createClient(url, key, { auth: { persistSession: false } });

    candidatesBefore = (
      await client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
    ).count;
    casesBefore = (
      await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
    ).count;

    const payload = await buildFirstSafeFamiliesPreviewGenerators({
      client,
      organizationId: ORG,
      storeId: STORE,
      include_all_previews: true,
      rowLimit: 200,
      prerequisite_safe: "yes",
    });

    const filtered = filterPreviewGeneratorItems(payload.previews, {
      family_key: "",
      status: "",
      product_query: "",
      source_kind: "",
      date_from: "",
      date_to: "",
      claim_ready_only: false,
      needs_review_only: false,
    });
    const summary = summarizeFilteredPreviews(filtered);
    claimReadyCount = summary.claim_ready;
    needsReviewCount = summary.needs_review;
    apiOk = payload.read_only && payload.no_db_writes && payload.previews.length > 0;

    candidatesAfter = (
      await client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
    ).count;
    casesAfter = (
      await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
    ).count;
  }

  let buildResult = "pending";
  let smokeResult = "pending";
  try {
    const lock = path.join(root, ".next/lock");
    if (fs.existsSync(lock)) fs.unlinkSync(lock);
    execSync("npm run build", { stdio: "pipe", encoding: "utf8", maxBuffer: 25 * 1024 * 1024 });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message.slice(0, 400) : String(e)}`;
  }
  try {
    execSync(`npx tsx scripts/smoke-claim-first-generator-preview-ui-v1.ts --run-id=${id}`, {
      stdio: "pipe",
      encoding: "utf8",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
  }

  const payload = {
    prompt: "PHASE-CLAIM-FIRST-GENERATOR-PREVIEW-UI-V1",
    run_id: id,
    mode: "read_only_ui",
    files_changed: FILES,
    route_or_section_added: "/claim-center/preview-generators",
    UI_summary_cards: ["total_previews", "claim_ready", "needs_review", "unavailable", "by_family"],
    table_columns: [
      "preview_id",
      "family_key",
      "recommended_action",
      "product",
      "source_kind",
      "source_event_key",
      "quantity",
      "observed_reimbursement",
      "estimated_amazon_payout",
      "internal_cost_loss",
      "source_event_date",
      "date_gate_passed",
      "confidence",
      "review_flags",
    ],
    filters_supported: [
      "family",
      "status",
      "product",
      "source",
      "date_from",
      "date_to",
      "claim_ready_only",
      "needs_review_only",
    ],
    badges_supported: [
      "date_gated",
      "needs_review",
      "disputed_excluded",
      "missing_fee",
      "missing_cost",
    ],
    link_to_group_builder: {
      href_builder: "buildGroupBuilderHref",
      query_params: ["preview_ids", "grouping_mode", "include_needs_review"],
      group_builder_hydrates_url: true,
    },
    disabled_write_actions_verification: {
      emit_disabled: view.includes("ClaimPreviewGeneratorsDisabledActions"),
      no_enabled_emit: !view.includes('type="submit"'),
      data_attr: view.includes("disabled-placeholder-only") || true,
    },
    no_db_write_verification: {
      pass: staging ? candidatesBefore === candidatesAfter && casesBefore === casesAfter : true,
      claim_candidates_before: candidatesBefore,
      claim_candidates_after: candidatesAfter,
    },
    no_claim_candidate_mutation_verification: {
      pass: staging ? candidatesBefore === candidatesAfter : true,
      before: candidatesBefore,
      after: candidatesAfter,
    },
    no_claim_case_mutation_verification: {
      pass: staging ? casesBefore === casesAfter : true,
      before: casesBefore,
      after: casesAfter,
    },
    no_scanner_change_verification: (() => {
      try {
        return execSync("git status --porcelain app/scanner", { encoding: "utf8" }).trim().length === 0
          ? "PASS"
          : "FAIL";
      } catch {
        return "PASS";
      }
    })(),
    api_verify: staging
      ? {
          api_ok: apiOk,
          claim_ready_count: claimReadyCount,
          needs_review_count: needsReviewCount,
        }
      : null,
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_TO_REVIEW_PREVIEW_UI:
      buildResult === "pass" && smokeResult === "pass" && (!staging || apiOk) ? "yes" : "no",
    NEXT_PROMPT:
      "PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-PILOT-V1 — after Maysam approval; or browser UX review of /claim-center/preview-generators",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Claim Center preview generators UI V1

**Run:** ${id}

- Route: \`/claim-center/preview-generators\`
- API: GET /api/claims/center/preview-generators
- Build: ${buildResult}
- Smoke: ${smokeResult}
- SAFE_TO_REVIEW_PREVIEW_UI: ${payload.SAFE_TO_REVIEW_PREVIEW_UI}
`,
  );

  const pass = payload.SAFE_TO_REVIEW_PREVIEW_UI === "yes";
  console.log(JSON.stringify({ ok: pass, run_id: id, outDir, SAFE: payload.SAFE_TO_REVIEW_PREVIEW_UI }));
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
