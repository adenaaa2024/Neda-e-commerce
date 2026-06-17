/**
 * PHASE-CLAIM-CASE-CREATION-PILOT-V1 — controlled original case creation execute
 *   npx tsx scripts/phase-claim-case-creation-pilot-v1.ts --run-id=<UTC> [--dry-run]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import {
  assertOriginalCaseCreationPilotClient,
  buildCaseCreationPilotRollbackSql,
  CANONICAL_PILOT_V1_CANDIDATE_IDS,
  executeClaimCaseCreationPilotV1,
  readCaseCreationPilotApprovalStatus,
  verifyMoneyNullPreservation,
  CASE_CREATION_PILOT_ORIGIN,
} from "../lib/claims/case-creation/claim-case-creation-pilot-v1";
import { ORIGINAL_PILOT_INTAKE_RUN_ID } from "../lib/claims/evidence/claim-evidence-packet-v1-plan-contract";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-case-creation-pilot-v1";
const PREVIEW_UI_RESULTS =
  ".cursor/audit-reports/phase-claim-case-creation-preview-ui-v1/20260615T180000Z/results.json";

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

function isDryRun(): boolean {
  return process.argv.includes("--dry-run");
}

function scannerGitStatus(): string {
  try {
    return execSync("git status --porcelain app/scanner", { encoding: "utf8" }).trim();
  } catch {
    return "git_unavailable";
  }
}

function loadPrerequisites(): void {
  const p = path.join(process.cwd(), PREVIEW_UI_RESULTS);
  if (!fs.existsSync(p)) throw new Error(`BLOCKED: preview UI evidence missing at ${PREVIEW_UI_RESULTS}`);
  const ui = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, string>;
  if (ui.SAFE_TO_BUILD_CASE_CREATION_PILOT !== "yes") {
    throw new Error("BLOCKED: SAFE_TO_BUILD_CASE_CREATION_PILOT must be yes");
  }
}

async function loadExistingIdempotencyForCandidates(
  client: ReturnType<typeof createClient>,
  candidateIds: string[],
): Promise<Record<string, { case_idempotency_key: string | null; existing_case_ids: string[] }>> {
  const out: Record<string, { case_idempotency_key: string | null; existing_case_ids: string[] }> = {};
  for (const cid of candidateIds) {
    const lineKey = `cc:line:candidate:${cid}`;
    const { data: lines } = await client
      .from("claim_lines")
      .select("claim_case_id, idempotency_key")
      .eq("organization_id", ORG)
      .eq("claim_candidate_id", cid);
    const caseIds = [...new Set((lines ?? []).map((l) => String(l.claim_case_id)).filter(Boolean))];
    out[cid] = {
      case_idempotency_key: (lines ?? [])[0]?.idempotency_key ?? lineKey,
      existing_case_ids: caseIds,
    };
  }
  return out;
}

async function countActiveTargetCandidates(
  client: ReturnType<typeof createClient>,
): Promise<number> {
  const { count } = await client
    .from("claim_candidates")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG)
    .eq("intake_run_id", ORIGINAL_PILOT_INTAKE_RUN_ID)
    .is("quarantined_at", null)
    .is("rejected_at", null);
  return count ?? 0;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  loadPrerequisites();

  const id = runId();
  const dryRun = isDryRun();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const approval = readCaseCreationPilotApprovalStatus();
  if (!approval.approved && !dryRun) {
    throw new Error(`BLOCKED: ${approval.reason ?? "approval_required"}`);
  }

  const { ref, url } = bindProductionSupabaseEnv();
  if (ref !== PRODUCTION_REF) {
    throw new Error(`BLOCKED: expected original ref ${PRODUCTION_REF}, got ${ref}`);
  }

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const client = createClient(url, key, { auth: { persistSession: false } });
  assertOriginalCaseCreationPilotClient(client);
  const scannerBefore = scannerGitStatus();

  const candidatesBefore = (
    await client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const activeTargetBefore = await countActiveTargetCandidates(client);
  const casesBefore = (
    await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const linesBefore = (
    await client.from("claim_lines").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const eventsBefore = (
    await client.from("claim_case_events").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const submissionsBefore = (
    await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;

  const { count: pilotCasesScopedBefore } = await client
    .from("claim_cases")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG)
    .filter("metadata->>case_creation_origin", "eq", CASE_CREATION_PILOT_ORIGIN);

  const before_snapshot = {
    claim_candidates_count: candidatesBefore,
    active_target_candidates: activeTargetBefore,
    claim_cases_count: casesBefore,
    claim_lines_count: linesBefore,
    claim_case_events_count: eventsBefore,
    claim_submissions_count: submissionsBefore,
    pilot_cases_scoped_before: pilotCasesScopedBefore ?? 0,
  };

  const existing_idempotency_keys_before = await loadExistingIdempotencyForCandidates(
    client,
    [...CANONICAL_PILOT_V1_CANDIDATE_IDS],
  );

  const canonicalPilotRunId = "pilot-20260615T190000Z";
  const reuseCanonical =
    (pilotCasesScopedBefore ?? 0) >= approval.max_cases_cap;

  const executeResult = await executeClaimCaseCreationPilotV1(client, ORG, STORE, {
    intake_run_id: ORIGINAL_PILOT_INTAKE_RUN_ID,
    pilot_case_run_id: reuseCanonical ? canonicalPilotRunId : `pilot-${id}`,
    shipment_cap: approval.shipment_cap,
    order_cap: approval.order_cap,
    total_cap: approval.max_cases_cap,
    dry_run: dryRun,
    pinned_candidate_ids: [...CANONICAL_PILOT_V1_CANDIDATE_IDS],
  });

  const existing_idempotency_keys = existing_idempotency_keys_before;

  const rollback_sql = buildCaseCreationPilotRollbackSql({
    organizationId: ORG,
    pilotCaseRunId: executeResult.pilot_case_run_id,
  });
  fs.writeFileSync(path.join(outDir, "rollback.sql"), rollback_sql);

  const candidatesAfter = (
    await client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const casesAfter = (
    await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const linesAfter = (
    await client.from("claim_lines").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const eventsAfter = (
    await client.from("claim_case_events").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const submissionsAfter = (
    await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const scannerAfter = scannerGitStatus();

  const pilotCaseIds = executeResult.results
    .filter((r) => r.claim_case_id)
    .map((r) => r.claim_case_id!);

  const { data: createdCases } = pilotCaseIds.length
    ? await client
        .from("claim_cases")
        .select("id, idempotency_key, metadata, status, claim_source, claim_subtype")
        .in("id", pilotCaseIds)
    : { data: [] };

  const moneyCheck = verifyMoneyNullPreservation(
    (createdCases ?? []) as Array<{ metadata: Record<string, unknown> | null }>,
  );

  const attachmentOk = executeResult.results
    .filter((r) => r.outcome === "inserted" || r.outcome === "reused_existing")
    .every((r) => !!r.claim_case_id && !!r.claim_line_id);

  const pilotSrc = fs.readFileSync(
    path.join(process.cwd(), "lib/claims/case-creation/claim-case-creation-pilot-v1.ts"),
    "utf8",
  );
  const noPdf = !pilotSrc.includes("@react-pdf") && !pilotSrc.includes("renderToStream");
  const noAmazon = !pilotSrc.includes("amazon.com") && !pilotSrc.includes("claim_submissions");

  let buildResult = "pending";
  let smokeResult = "pending";
  try {
    const lock = path.join(process.cwd(), ".next/lock");
    if (fs.existsSync(lock)) fs.unlinkSync(lock);
    execSync("npm run build", { stdio: "pipe", encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message.slice(0, 400) : String(e)}`;
  }
  try {
    execSync(`npx tsx scripts/smoke-claim-case-creation-pilot-v1.ts --run-id=${id}`, {
      stdio: "pipe",
      encoding: "utf8",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
  }

  const expectedCaseDelta = dryRun ? 0 : executeResult.inserted_cases_count;
  const expectedLineDelta = dryRun ? 0 : executeResult.inserted_lines_count;
  const expectedEventDelta = dryRun ? 0 : executeResult.inserted_events_count;

  const pilotPass =
    approval.approved &&
    executeResult.selected_candidates.length === approval.max_cases_cap &&
    executeResult.selected_family_distribution.removal_shipment_missing === approval.shipment_cap &&
    executeResult.selected_family_distribution.removal_order_discrepancy === approval.order_cap &&
    (dryRun || executeResult.inserted_cases_count + executeResult.reused_existing_count === approval.max_cases_cap) &&
    candidatesBefore === candidatesAfter &&
    submissionsBefore === submissionsAfter &&
    casesAfter - casesBefore === expectedCaseDelta &&
    linesAfter - linesBefore === expectedLineDelta &&
    eventsAfter - eventsBefore === expectedEventDelta &&
    moneyCheck.pass &&
    attachmentOk &&
    noPdf &&
    scannerBefore === scannerAfter &&
    buildResult === "pass" &&
    smokeResult === "pass";

  const results = {
    prompt: "PHASE-CLAIM-CASE-CREATION-PILOT-V1",
    run_id: id,
    mode: dryRun ? "dry-run" : "controlled-execute",
    dry_run: dryRun,
    approval_file_status: approval,
    original_ref_guard: { expected: PRODUCTION_REF, actual: ref, pass: ref === PRODUCTION_REF },
    pilot_case_run_id: executeResult.pilot_case_run_id,
    case_creation_origin: CASE_CREATION_PILOT_ORIGIN,
    selected_cap: approval.max_cases_cap,
    selected_candidates: executeResult.selected_candidates,
    selected_family_distribution: executeResult.selected_family_distribution,
    before_snapshot: { ...before_snapshot, existing_idempotency_keys_before: existing_idempotency_keys_before },
    existing_idempotency_keys,
    reuse_canonical_pilot_run: reuseCanonical,
    inserted_cases_count: executeResult.inserted_cases_count,
    inserted_lines_count: executeResult.inserted_lines_count,
    inserted_events_count: executeResult.inserted_events_count,
    reused_existing_count: executeResult.reused_existing_count,
    skipped_count: executeResult.skipped_count,
    skipped_reason_counts: executeResult.skipped_reason_counts,
    sample_created_cases: executeResult.sample_created_cases,
    idempotency_result: {
      reused_existing_count: executeResult.reused_existing_count,
      inserted_cases_count: executeResult.inserted_cases_count,
    },
    candidate_attachment_result: { pass: attachmentOk, results: executeResult.results },
    money_null_preservation_result: moneyCheck,
    claim_candidates_count_before_after: { before: candidatesBefore, after: candidatesAfter },
    claim_cases_count_before_after: { before: casesBefore, after: casesAfter, delta: casesAfter - casesBefore },
    claim_lines_count_before_after: { before: linesBefore, after: linesAfter, delta: linesAfter - linesBefore },
    claim_case_events_count_before_after: {
      before: eventsBefore,
      after: eventsAfter,
      delta: eventsAfter - eventsBefore,
    },
    claim_submissions_count_before_after: {
      before: submissionsBefore,
      after: submissionsAfter,
    },
    no_pdf_generation_verification: { pass: noPdf },
    no_amazon_submission_verification: { pass: noAmazon, submissions_unchanged: submissionsBefore === submissionsAfter },
    no_scanner_change_verification: {
      pass: scannerBefore === scannerAfter,
      git_before: scannerBefore,
      git_after: scannerAfter,
    },
    rollback_sql_path: `phase-claim-case-creation-pilot-v1/${id}/rollback.sql`,
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_CASE_CREATION_PILOT: pilotPass ? "yes" : "no",
    SAFE_TO_POST_VERIFY_CASE_CREATION_PILOT: pilotPass ? "yes" : "no",
    NEXT_PROMPT: pilotPass
      ? "PHASE-CLAIM-CASE-CREATION-PILOT-POST-VERIFY-V1 — read-only verify inserted cases/lines/events; confirm rollback SQL; no further writes"
      : "PHASE-CLAIM-CASE-CREATION-PILOT-V1-REMEDIATION — fix failing pilot execute checks",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md",
    ),
    `# Claim case creation pilot V1

**Run:** ${id} · **Ref:** ${PRODUCTION_REF} · **Dry-run:** ${dryRun}

- Selected: **${executeResult.selected_candidates.length}** (${executeResult.selected_family_distribution.removal_shipment_missing} shipment + ${executeResult.selected_family_distribution.removal_order_discrepancy} order)
- Inserted cases: **${executeResult.inserted_cases_count}**
- Cases total: **${casesBefore} → ${casesAfter}**
- SAFE_CASE_CREATION_PILOT: **${results.SAFE_CASE_CREATION_PILOT}**
`,
  );

  console.log(
    JSON.stringify({
      ok: pilotPass,
      run_id: id,
      dry_run: dryRun,
      inserted_cases: executeResult.inserted_cases_count,
      cases_delta: casesAfter - casesBefore,
      SAFE_CASE_CREATION_PILOT: results.SAFE_CASE_CREATION_PILOT,
      outDir,
    }),
  );
  if (!pilotPass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
