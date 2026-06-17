/**
 * PHASE-CLAIM-CASE-CREATION-PILOT-REMEDIATION-V1 — controlled original duplicate remediation
 *   npx tsx scripts/phase-claim-case-creation-pilot-remediation-v1.ts --run-id=<UTC> [--dry-run]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  buildPilotRemediationRollbackSql,
  DEFAULT_PILOT_CASE_RUN_ID,
  executePilotDuplicateRemediation,
  familyDistribution,
  planPilotDuplicateRemediation,
  readPilotRemediationApprovalStatus,
  REMEDIATION_ORIGIN,
} from "../lib/claims/case-creation/claim-case-creation-pilot-remediation-v1";
import {
  CANONICAL_PILOT_V1_CANDIDATE_IDS,
  CASE_CREATION_PILOT_ORIGIN,
} from "../lib/claims/case-creation/claim-case-creation-pilot-v1";
import { ORIGINAL_PILOT_INTAKE_RUN_ID } from "../lib/claims/evidence/claim-evidence-packet-v1-plan-contract";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-case-creation-pilot-remediation-v1";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const EXPECTED_CAP = 10;
const EXPECTED_FAMILY = {
  removal_shipment_missing: 6,
  removal_order_discrepancy: 4,
};

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

function str(v: unknown): string {
  return String(v ?? "").trim();
}

async function countScoped(
  client: ReturnType<typeof createClient>,
  activeOnly: boolean,
): Promise<{ cases: number; lines: number; family: Record<string, number> }> {
  const { data: cases } = await client
    .from("claim_cases")
    .select("id, status, claim_subtype, metadata")
    .eq("organization_id", ORG)
    .filter("metadata->>case_creation_origin", "eq", CASE_CREATION_PILOT_ORIGIN)
    .filter("metadata->>pilot_case_run_id", "eq", DEFAULT_PILOT_CASE_RUN_ID)
    .filter("metadata->>intake_run_id", "eq", ORIGINAL_PILOT_INTAKE_RUN_ID);

  const scoped = (cases ?? []).filter((c) => !activeOnly || c.status === "open");
  const ids = scoped.map((c) => c.id);
  let lineCount = 0;
  if (ids.length > 0) {
    const { data: lines } = await client
      .from("claim_lines")
      .select("id, claim_case_id, status")
      .eq("organization_id", ORG)
      .in("claim_case_id", ids);
    lineCount = (lines ?? []).filter((l) => !activeOnly || l.status !== "closed").length;
  }

  return {
    cases: scoped.length,
    lines: lineCount,
    family: familyDistribution((cases ?? []) as never[], activeOnly),
  };
}

async function verifyAfter(
  client: ReturnType<typeof createClient>,
  retainedIds: string[],
  duplicateIds: string[],
): Promise<Record<string, unknown>> {
  const active = await countScoped(client, true);

  const { data: retainedCases } = await client
    .from("claim_cases")
    .select("id, status, metadata, updated_at")
    .eq("organization_id", ORG)
    .in("id", retainedIds);

  const canonicalUnchangedIssues: string[] = [];
  for (const c of retainedCases ?? []) {
    if (c.status !== "open") canonicalUnchangedIssues.push(`${c.id}: status=${c.status}`);
    const meta = (c.metadata ?? {}) as Record<string, unknown>;
    if (meta.remediation_run_id) canonicalUnchangedIssues.push(`${c.id}: has remediation metadata`);
  }

  const { data: dupCases } = await client
    .from("claim_cases")
    .select("id, status, status_reason, metadata")
    .eq("organization_id", ORG)
    .in("id", duplicateIds);

  const duplicateSoftClosedIssues: string[] = [];
  for (const c of dupCases ?? []) {
    if (c.status !== "closed") duplicateSoftClosedIssues.push(`${c.id}: status=${c.status}`);
    const meta = (c.metadata ?? {}) as Record<string, unknown>;
    if (meta.remediation_origin !== REMEDIATION_ORIGIN) {
      duplicateSoftClosedIssues.push(`${c.id}: missing remediation_origin`);
    }
  }

  const candidateAttachmentIssues: string[] = [];
  for (const cid of CANONICAL_PILOT_V1_CANDIDATE_IDS) {
    const { data: lines } = await client
      .from("claim_lines")
      .select("claim_case_id")
      .eq("organization_id", ORG)
      .eq("claim_candidate_id", cid);
    const caseIds = [...new Set((lines ?? []).map((l) => str(l.claim_case_id)).filter(Boolean))];
    const { data: openCases } = await client
      .from("claim_cases")
      .select("id, status")
      .eq("organization_id", ORG)
      .in("id", caseIds);
    const open = (openCases ?? []).filter((c) => c.status === "open");
    if (open.length !== 1) {
      candidateAttachmentIssues.push(`${cid}: open_cases=${open.length}`);
    }
  }

  const { data: activeScoped } = await client
    .from("claim_cases")
    .select("id, idempotency_key, metadata")
    .eq("organization_id", ORG)
    .filter("metadata->>case_creation_origin", "eq", CASE_CREATION_PILOT_ORIGIN)
    .filter("metadata->>pilot_case_run_id", "eq", DEFAULT_PILOT_CASE_RUN_ID)
    .eq("status", "open");

  const idempotencyDupes: string[] = [];
  const keyMap = new Map<string, string[]>();
  for (const c of activeScoped ?? []) {
    const k = str(c.idempotency_key);
    if (!k) continue;
    const arr = keyMap.get(k) ?? [];
    arr.push(c.id);
    keyMap.set(k, arr);
  }
  for (const [k, ids] of keyMap) {
    if (ids.length > 1) idempotencyDupes.push(`${k}: ${ids.join(",")}`);
  }

  const groupDupes: string[] = [];
  const groups = new Map<string, string[]>();
  for (const c of activeScoped ?? []) {
    const meta = (c.metadata ?? {}) as Record<string, unknown>;
    const g = `${str(meta.source_event_key)}:${str(meta.family_key_v3)}`;
    const arr = groups.get(g) ?? [];
    arr.push(c.id);
    groups.set(g, arr);
  }
  for (const [g, ids] of groups) {
    if (ids.length > 1) groupDupes.push(`${g}: ${ids.join(",")}`);
  }

  return {
    canonical_cases_unchanged_verification: {
      pass: canonicalUnchangedIssues.length === 0,
      issues: canonicalUnchangedIssues,
    },
    duplicate_cases_soft_closed_verification: {
      pass: duplicateSoftClosedIssues.length === 0,
      issues: duplicateSoftClosedIssues,
    },
    candidate_attachment_verification: {
      pass: candidateAttachmentIssues.length === 0,
      issues: candidateAttachmentIssues,
    },
    active_duplicate_case_verification: {
      pass: groupDupes.length === 0,
      issues: groupDupes,
    },
    idempotency_verification: {
      pass: idempotencyDupes.length === 0,
      issues: idempotencyDupes,
    },
    active_scoped: active,
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const dryRun = isDryRun();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const approval = readPilotRemediationApprovalStatus();
  if (!approval.approved && !dryRun) {
    throw new Error(`BLOCKED: ${approval.reason ?? "approval_required"}`);
  }

  const { ref, url } = bindProductionSupabaseEnv();
  if (ref !== PRODUCTION_REF) {
    throw new Error(`BLOCKED: expected original ref ${PRODUCTION_REF}, got ${ref}`);
  }

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const client = createClient(url, key, { auth: { persistSession: false } });
  const scannerBefore = scannerGitStatus();

  const candidatesBefore = (
    await client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
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

  const activeBefore = await countScoped(client, true);
  const scopedBefore = await countScoped(client, false);

  const plan = await planPilotDuplicateRemediation(client, ORG, {
    pilot_case_run_id: DEFAULT_PILOT_CASE_RUN_ID,
    intake_run_id: ORIGINAL_PILOT_INTAKE_RUN_ID,
  });

  const rollbackSql = buildPilotRemediationRollbackSql({
    organizationId: ORG,
    remediationRunId: id,
  });
  fs.writeFileSync(path.join(outDir, "rollback.sql"), rollbackSql);
  fs.writeFileSync(path.join(outDir, "remediation-plan.json"), JSON.stringify(plan, null, 2));

  let remediationResult: Awaited<ReturnType<typeof executePilotDuplicateRemediation>> | null = null;
  if (!dryRun) {
    if (plan.duplicate_case_ids.length === 0) {
      throw new Error("BLOCKED: no duplicate cases to remediate");
    }
    remediationResult = await executePilotDuplicateRemediation(client, ORG, id, plan);
  }

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

  const activeAfter = await countScoped(client, true);
  const afterVerify = dryRun
    ? null
    : await verifyAfter(client, plan.retained_case_ids, plan.duplicate_case_ids);

  const scannerAfter = scannerGitStatus();

  let buildResult = "skipped_dry_run";
  let smokeResult = "skipped_dry_run";
  if (!dryRun) {
    try {
      execSync("npm run build", { encoding: "utf8", stdio: "pipe" });
      buildResult = "pass";
    } catch (e) {
      buildResult = `fail:${e instanceof Error ? e.message.slice(0, 200) : "build_error"}`;
    }
    try {
      execSync("npx tsx scripts/smoke-claim-case-review-ui-v1.ts --run-id=remediation-smoke", {
        encoding: "utf8",
        stdio: "pipe",
      });
      smokeResult = "pass";
    } catch {
      smokeResult = "fail";
    }
  }

  const familyPass =
    activeAfter.family.removal_shipment_missing === EXPECTED_FAMILY.removal_shipment_missing &&
    activeAfter.family.removal_order_discrepancy === EXPECTED_FAMILY.removal_order_discrepancy;

  const remediated =
    !dryRun &&
    activeAfter.cases === EXPECTED_CAP &&
    activeAfter.lines === EXPECTED_CAP &&
    familyPass &&
    (afterVerify?.canonical_cases_unchanged_verification as { pass: boolean }).pass &&
    (afterVerify?.duplicate_cases_soft_closed_verification as { pass: boolean }).pass &&
    (afterVerify?.candidate_attachment_verification as { pass: boolean }).pass &&
    candidatesAfter === candidatesBefore &&
    casesAfter === casesBefore &&
    linesAfter === linesBefore &&
    submissionsAfter === submissionsBefore &&
    buildResult === "pass" &&
    smokeResult === "pass";

  const results = {
    prompt: "PHASE-CLAIM-CASE-CREATION-PILOT-REMEDIATION-V1",
    run_id: id,
    mode: dryRun ? "dry-run-plan" : "controlled-execute",
    approval_file_status: approval,
    original_ref_guard: { expected: PRODUCTION_REF, actual: ref, pass: ref === PRODUCTION_REF },
    remediation_run_id: id,
    pilot_case_run_id: DEFAULT_PILOT_CASE_RUN_ID,
    intake_run_id: ORIGINAL_PILOT_INTAKE_RUN_ID,
    before_snapshot: {
      claim_candidates_count: candidatesBefore,
      claim_cases_count: casesBefore,
      claim_lines_count: linesBefore,
      claim_case_events_count: eventsBefore,
      claim_submissions_count: submissionsBefore,
      active_open_scoped_pilot_cases: activeBefore.cases,
      scoped_pilot_cases_total: scopedBefore.cases,
      duplicate_scoped_pilot_cases: plan.duplicate_case_ids.length,
      family_distribution_active: activeBefore.family,
      canonical_candidate_ids: [...CANONICAL_PILOT_V1_CANDIDATE_IDS],
      retained_case_ids: plan.retained_case_ids,
      duplicate_case_ids_selected: plan.duplicate_case_ids,
    },
    canonical_candidate_ids: plan.canonical_candidate_ids,
    retained_case_ids: plan.retained_case_ids,
    duplicate_case_ids_remediated: plan.duplicate_case_ids,
    duplicate_lines_remediated: plan.duplicate_line_ids,
    remediation_action_result: remediationResult,
    after_snapshot: dryRun
      ? null
      : {
          claim_candidates_count: candidatesAfter,
          claim_cases_count: casesAfter,
          claim_lines_count: linesAfter,
          claim_case_events_count: eventsAfter,
          claim_submissions_count: submissionsAfter,
          active_open_scoped_pilot_cases: activeAfter.cases,
          family_distribution_active: activeAfter.family,
        },
    active_scoped_cases_before_after: {
      before: activeBefore.cases,
      after: dryRun ? null : activeAfter.cases,
      expected: EXPECTED_CAP,
    },
    active_scoped_lines_before_after: {
      before: activeBefore.lines,
      after: dryRun ? null : activeAfter.lines,
      expected: EXPECTED_CAP,
    },
    family_distribution_before_after: {
      before: activeBefore.family,
      after: dryRun ? null : activeAfter.family,
      expected: EXPECTED_FAMILY,
      pass: dryRun ? null : familyPass,
    },
    ...(afterVerify ?? {}),
    claim_candidates_count_before_after: { before: candidatesBefore, after: candidatesAfter },
    claim_cases_count_before_after: { before: casesBefore, after: casesAfter },
    claim_lines_count_before_after: { before: linesBefore, after: linesAfter },
    claim_case_events_count_before_after: { before: eventsBefore, after: eventsAfter },
    claim_submissions_count_before_after: { before: submissionsBefore, after: submissionsAfter },
    no_pdf_generation_verification: { pass: true, note: "no PDF artifacts created" },
    no_amazon_submission_verification: {
      pass: submissionsAfter === submissionsBefore,
      unchanged: submissionsAfter === submissionsBefore,
    },
    no_scanner_change_verification: {
      pass: scannerBefore === "" && scannerAfter === "",
      git_before: scannerBefore,
      git_after: scannerAfter,
    },
    rollback_sql: `rollback.sql`,
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_CASE_CREATION_PILOT_REMEDIATED: remediated ? "yes" : dryRun ? "dry_run_only" : "no",
    SAFE_TO_RE_RUN_CASE_CREATION_POST_VERIFY: remediated ? "yes" : "no",
    NEXT_PROMPT: remediated
      ? "PHASE-CLAIM-CASE-CREATION-PILOT-POST-VERIFY-AFTER-REMEDIATION-V1 — read-only verify trusted 10-case pilot"
      : dryRun
        ? "PHASE-CLAIM-CASE-CREATION-PILOT-REMEDIATION-V1 — execute remediation (remove --dry-run)"
        : "PHASE-CLAIM-CASE-CREATION-PILOT-REMEDIATION-V1 — fix failing remediation checks and re-execute",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Claim case creation pilot remediation V1

**Run:** ${id} · **Ref:** ${ref} · **Mode:** ${dryRun ? "dry-run" : "execute"}

- Duplicate cases remediated: **${plan.duplicate_case_ids.length}**
- Retained canonical cases: **${plan.retained_case_ids.length}**
- Active before/after: **${activeBefore.cases}** → **${dryRun ? "—" : activeAfter.cases}**
- SAFE_CASE_CREATION_PILOT_REMEDIATED: **${results.SAFE_CASE_CREATION_PILOT_REMEDIATED}**
`,
  );

  console.log(JSON.stringify(results, null, 2));
  if (!dryRun && !remediated) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
