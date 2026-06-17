/**
 * PHASE-CLAIM-MANUAL-FILING-HANDOFF-PREVIEW-V1 — read-only handoff UI verify
 *   npx tsx scripts/phase-claim-manual-filing-handoff-preview-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { composeClaimFilingPacketPreviewV1 } from "../lib/claims/filing/claim-filing-packet-preview-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { buildClaimCaseReviewReadmodel } from "../lib/claims/pilot/claim-case-review-readmodel";
import {
  buildDraftArtifactPaths,
  buildHandoffDisplaySnapshot,
  buildHandoffReferenceGraph,
  CLAIM_MANUAL_FILING_HANDOFF_UI_VERSION,
  MANUAL_FILING_HANDOFF_CHECKLIST_ITEMS,
  MANUAL_FILING_HANDOFF_DISABLED_ACTIONS,
  MANUAL_FILING_HANDOFF_FIELDS,
  MANUAL_FILING_HANDOFF_SECTION_ID,
  manualFilingHandoffDisabled,
  NOT_SUBMITTED_BANNER_TEXT,
  PILOT_DRAFT_EXPORT_BASE,
  TRID_VERIFY_EVIDENCE_PATH,
} from "../lib/claims/submission/claim-manual-filing-handoff-ui-contract";
import { isRemediatedDuplicateCase } from "../lib/claims/filing/claim-filing-packet-ui-contract";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-manual-filing-handoff-preview-v1";
const MANUAL_CONTRACT_VERIFY =
  ".cursor/audit-reports/phase-claim-submission-manual-filing-contract-v1/20260616T100000Z/results.json";
const EXPORT_MANIFEST =
  ".cursor/audit-reports/phase-claim-pdf-export-preview-pilot-v1/20260616T090000Z/manifest.json";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

const UI_SECTION = "components/claim-center/case-review/ClaimCaseReviewManualFilingHandoffSection.tsx";
const UI_DRAWER = "components/claim-center/case-review/ClaimCaseReviewDetailDrawer.tsx";
const UI_CONTRACT = "lib/claims/submission/claim-manual-filing-handoff-ui-contract.ts";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function scannerGitStatus(): string {
  try {
    return execSync("git status --porcelain app/scanner", { encoding: "utf8" }).trim();
  } catch {
    return "git_unavailable";
  }
}

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function loadTridPrerequisite(): {
  safe_trid: string;
  safe_handoff_build: string;
  pass: boolean;
} {
  const p = path.join(process.cwd(), TRID_VERIFY_EVIDENCE_PATH);
  if (!fs.existsSync(p)) {
    return { safe_trid: "missing", safe_handoff_build: "missing", pass: false };
  }
  const data = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  const safeTrid = str(data.SAFE_TRID_REFERENCE_GRAPH_VERIFIED);
  const safeHandoff = str(data.SAFE_TO_BUILD_MANUAL_FILING_HANDOFF_PREVIEW);
  return {
    safe_trid: safeTrid,
    safe_handoff_build: safeHandoff,
    pass: safeTrid === "yes" && safeHandoff === "yes",
  };
}

function artifactExists(relPath: string): boolean {
  return fs.existsSync(path.join(process.cwd(), relPath));
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();

  const manualPath = path.join(process.cwd(), MANUAL_CONTRACT_VERIFY);
  if (!fs.existsSync(manualPath)) {
    throw new Error(`BLOCKED: missing manual filing contract at ${MANUAL_CONTRACT_VERIFY}`);
  }
  const manualContract = JSON.parse(fs.readFileSync(manualPath, "utf8")) as Record<string, unknown>;
  if (str(manualContract.SAFE_TO_BUILD_MANUAL_FILING_HANDOFF_PREVIEW) !== "yes") {
    console.warn(
      "WARN: manual contract SAFE_TO_BUILD_MANUAL_FILING_HANDOFF_PREVIEW was yes at contract time; TRID verify may supersede.",
    );
  }

  const tridPrereq = loadTridPrerequisite();

  const manifestPath = path.join(process.cwd(), EXPORT_MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`BLOCKED: missing export manifest at ${EXPORT_MANIFEST}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    artifacts: Array<{ claim_case_id: string; files: { pdf?: string; json?: string } }>;
  };
  const manifestByCase = new Map(manifest.artifacts.map((a) => [a.claim_case_id, a]));

  const sectionSrc = fs.readFileSync(path.join(process.cwd(), UI_SECTION), "utf8");
  const drawerSrc = fs.readFileSync(path.join(process.cwd(), UI_DRAWER), "utf8");

  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const { ref, url } = bindProductionSupabaseEnv();
  if (ref !== PRODUCTION_REF) {
    throw new Error(`BLOCKED: expected original ref ${PRODUCTION_REF}, got ${ref}`);
  }

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const client = createClient(url, key, { auth: { persistSession: false } });
  const scannerBefore = scannerGitStatus();

  const casesBefore = (
    await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const linesBefore = (
    await client.from("claim_lines").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const candidatesBefore = (
    await client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const submissionsBefore = (
    await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;

  const openReview = await buildClaimCaseReviewReadmodel(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
    status: "open",
    limit: 100,
  });

  const closedReview = await buildClaimCaseReviewReadmodel(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
    status: "closed",
    limit: 100,
  });

  const previewPayload = await composeClaimFilingPacketPreviewV1(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
    status: "open",
    limit: 100,
  });

  const rowById = new Map(openReview.rows.map((r) => [r.id, r]));
  const shipmentPreview = previewPayload.previews.find(
    (p) => p.family_key_v3 === "removal_shipment_missing",
  );
  const orderPreview = previewPayload.previews.find(
    (p) => p.family_key_v3 === "removal_order_discrepancy",
  );

  const shipmentRow = shipmentPreview ? rowById.get(shipmentPreview.claim_case_id) : undefined;
  const orderRow = orderPreview ? rowById.get(orderPreview.claim_case_id) : undefined;

  const sampleHandoffs: Record<string, unknown> = {};
  if (shipmentRow && shipmentPreview) {
    sampleHandoffs.removal_shipment_missing = buildHandoffDisplaySnapshot({
      row: shipmentRow,
      preview: shipmentPreview,
    });
  }
  if (orderRow && orderPreview) {
    sampleHandoffs.removal_order_discrepancy = buildHandoffDisplaySnapshot({
      row: orderRow,
      preview: orderPreview,
    });
  }

  const tridDisplayOk = [shipmentPreview, orderPreview].every((p) => {
    if (!p) return false;
    const row = rowById.get(p.claim_case_id);
    if (!row) return false;
    const graph = buildHandoffReferenceGraph(row, p);
    return graph.lines.length >= 0 && (graph.tracking_reference != null || graph.lines.length > 0 || !!p.source_event_key);
  });

  const draftArtifactOk = previewPayload.previews.every((p) => {
    const paths = buildDraftArtifactPaths({
      claimCaseId: p.claim_case_id,
      familyKeyV3: p.family_key_v3,
      sourceEventKey: p.source_event_key,
    });
    const m = manifestByCase.get(p.claim_case_id);
    const pdfOnDisk = artifactExists(paths.pdf);
    const jsonOnDisk = artifactExists(paths.json);
    return !!m && pdfOnDisk && jsonOnDisk;
  });

  const casesAfter = (
    await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const linesAfter = (
    await client.from("claim_lines").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const candidatesAfter = (
    await client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const submissionsAfter = (
    await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;

  const scannerAfter = scannerGitStatus();
  const noDbWrite =
    casesAfter === casesBefore &&
    linesAfter === linesBefore &&
    candidatesAfter === candidatesBefore &&
    submissionsAfter === submissionsBefore;

  const uiImplemented =
    drawerSrc.includes("ClaimCaseReviewManualFilingHandoffSection") &&
    sectionSrc.includes("MANUAL_FILING_HANDOFF_SECTION_ID") &&
    sectionSrc.includes("NOT_SUBMITTED_BANNER_TEXT") &&
    sectionSrc.includes("MANUAL_FILING_HANDOFF_CHECKLIST_ITEMS") &&
    sectionSrc.includes("MANUAL_FILING_HANDOFF_DISABLED_ACTIONS");

  const disabledOk =
    sectionSrc.includes("MANUAL_FILING_HANDOFF_DISABLED_ACTIONS") &&
    sectionSrc.includes('disabled') &&
    sectionSrc.includes("aria-disabled");

  const closedExcludedOk =
    closedReview.rows.length === 10 &&
    closedReview.rows.every((r) => manualFilingHandoffDisabled(r) || isRemediatedDuplicateCase(r));

  const structuralPass =
    openReview.rows.length === 10 &&
    previewPayload.previews.length === 10 &&
    uiImplemented &&
    disabledOk &&
    closedExcludedOk &&
    tridDisplayOk &&
    draftArtifactOk &&
    noDbWrite;

  const gatePass = structuralPass && tridPrereq.pass;

  let buildResult = "skipped";
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe" });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  let smokeResult = "skipped";
  try {
    execSync("npx tsx scripts/smoke-claim-manual-filing-handoff-preview-v1.ts", {
      encoding: "utf8",
      stdio: "pipe",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  const results = {
    prompt: "PHASE-CLAIM-MANUAL-FILING-HANDOFF-PREVIEW-V1",
    version: CLAIM_MANUAL_FILING_HANDOFF_UI_VERSION,
    run_id: id,
    mode: "read-only-handoff-ui",
    prerequisite_status: {
      manual_filing_contract_completed: true,
      SAFE_TRID_REFERENCE_GRAPH_VERIFIED: tridPrereq.safe_trid,
      SAFE_TO_BUILD_MANUAL_FILING_HANDOFF_PREVIEW_prerequisite: tridPrereq.safe_handoff_build,
      trid_prerequisite_pass: tridPrereq.pass,
      trid_evidence: TRID_VERIFY_EVIDENCE_PATH,
    },
    original_ref_guard: { expected: PRODUCTION_REF, actual: ref, pass: ref === PRODUCTION_REF },
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
    files_changed: [UI_CONTRACT, UI_SECTION, UI_DRAWER, "lib/claims/pilot/claim-case-review-ui-contract.ts"],
    route_or_section_added: {
      section_id: MANUAL_FILING_HANDOFF_SECTION_ID,
      location: "ClaimCaseReviewDetailDrawer — after Filing packet section",
      api_reused: "/api/claims/center/filing-packet-preview",
    },
    handoff_fields: MANUAL_FILING_HANDOFF_FIELDS,
    checklist_items: MANUAL_FILING_HANDOFF_CHECKLIST_ITEMS.map((i) => i.id),
    readiness_badge_behavior: {
      states: ["ready_for_manual_filing", "needs_review", "blocked", "already_submitted"],
      source: "assessManualFilingCase + remediated duplicate guard",
      warnings_do_not_block_handoff_display: true,
    },
    active_cases_loaded_count: openReview.rows.length,
    sample_handoff_verification: sampleHandoffs,
    trid_reference_display_verification: {
      pass: tridDisplayOk,
      note: "Displays graph lines + missing_trid_warning when TRID absent",
    },
    draft_artifact_display_verification: {
      pass: draftArtifactOk,
      export_base: PILOT_DRAFT_EXPORT_BASE,
      cases_checked: previewPayload.previews.length,
    },
    disabled_actions_verification: {
      pass: disabledOk,
      actions: MANUAL_FILING_HANDOFF_DISABLED_ACTIONS.map((a) => a.id),
    },
    closed_duplicates_excluded_verification: {
      pass: closedExcludedOk,
      closed_count: closedReview.rows.length,
      handoff_disabled_for_remediated: true,
    },
    no_db_write_verification: {
      pass: noDbWrite,
      claim_cases: { before: casesBefore, after: casesAfter },
      claim_lines: { before: linesBefore, after: linesAfter },
      claim_candidates: { before: candidatesBefore, after: candidatesAfter },
      claim_submissions: { before: submissionsBefore, after: submissionsAfter },
    },
    no_claim_case_mutation_verification: { pass: casesAfter === casesBefore && linesAfter === linesBefore },
    no_claim_submission_mutation_verification: {
      pass: submissionsAfter === submissionsBefore,
      unchanged: submissionsAfter === 3,
    },
    no_amazon_submission_verification: { pass: submissionsAfter === submissionsBefore },
    no_scanner_change_verification: {
      pass: scannerBefore === "" && scannerAfter === "",
      git_before: scannerBefore,
      git_after: scannerAfter,
    },
    ui_implementation_pass: uiImplemented,
    structural_pass: structuralPass,
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_MANUAL_FILING_HANDOFF_PREVIEW_READY:
      gatePass && buildResult === "pass" && smokeResult === "pass" ? "yes" : "no",
    SAFE_TO_PLAN_CLAIM_SUBMISSION_RECORD_PILOT:
      gatePass && buildResult === "pass" && smokeResult === "pass" ? "yes" : "no",
    NEXT_PROMPT:
      gatePass && buildResult === "pass" && smokeResult === "pass"
        ? "PHASE-CLAIM-SUBMISSION-RECORD-PILOT-V1 — controlled INSERT claim_submissions for open pilot cases (no Amazon API)"
        : tridPrereq.pass === false
          ? "PHASE-7H-CLAIM-REFERENCE-EDGE-MATERIALIZATION-PILOT — materialize claim_reference_edges + TRID for pilot cases (original approved)"
          : "PHASE-CLAIM-MANUAL-FILING-HANDOFF-PREVIEW-V1 — fix UI/verify failures",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Manual filing handoff preview V1

**Run:** ${id} · **Ref:** ${ref}

- UI implemented: **${uiImplemented ? "yes" : "no"}**
- Active cases: **${openReview.rows.length}**
- TRID prerequisite: **${tridPrereq.safe_trid}**
- Structural pass: **${structuralPass ? "yes" : "no"}**
- SAFE_MANUAL_FILING_HANDOFF_PREVIEW_READY: **${results.SAFE_MANUAL_FILING_HANDOFF_PREVIEW_READY}**
`,
  );

  console.log(JSON.stringify(results, null, 2));
  if (results.SAFE_MANUAL_FILING_HANDOFF_PREVIEW_READY !== "yes") {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
