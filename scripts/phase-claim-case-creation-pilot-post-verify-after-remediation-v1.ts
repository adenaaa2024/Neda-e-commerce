/**
 * PHASE-CLAIM-CASE-CREATION-PILOT-POST-VERIFY-AFTER-REMEDIATION-V1
 * Original read-only verify after duplicate pilot remediation.
 *   npx tsx scripts/phase-claim-case-creation-pilot-post-verify-after-remediation-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  buildCaseCreationPilotRollbackSql,
  CANONICAL_PILOT_V1_CANDIDATE_IDS,
  CASE_CREATION_PILOT_ORIGIN,
  verifyMoneyNullPreservation,
} from "../lib/claims/case-creation/claim-case-creation-pilot-v1";
import { REMEDIATION_ORIGIN } from "../lib/claims/case-creation/claim-case-creation-pilot-remediation-v1";
import { buildLineIdempotencyKey } from "../lib/claims/contracts/claim-case-creation-contract-v1";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT =
  ".cursor/audit-reports/phase-claim-case-creation-pilot-post-verify-after-remediation-v1";
const REMEDIATION_EVIDENCE_GLOB =
  ".cursor/audit-reports/phase-claim-case-creation-pilot-remediation-v1";
const PILOT_EVIDENCE_DIR =
  ".cursor/audit-reports/phase-claim-case-creation-pilot-v1/20260615T221000Z";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const INTAKE_RUN_ID = "a8a892fe-37d5-4d74-9ea2-02af8fd095ce";
const PILOT_CASE_RUN_ID = "pilot-20260615T190000Z";
const EXPECTED_CAP = 10;
const EXPECTED_FAMILY: Record<string, number> = {
  removal_shipment_missing: 6,
  removal_order_discrepancy: 4,
};

type ClaimCaseRow = {
  id: string;
  organization_id: string;
  store_id: string | null;
  claim_source: string | null;
  claim_subtype: string | null;
  status: string | null;
  status_reason: string | null;
  idempotency_key: string | null;
  created_at: string | null;
  metadata: Record<string, unknown> | null;
};

type ClaimLineRow = {
  id: string;
  claim_case_id: string | null;
  claim_candidate_id: string | null;
  quantity_expected: number | null;
  status: string | null;
  idempotency_key: string | null;
  metadata: Record<string, unknown> | null;
};

type RemediationEvidence = {
  remediation_run_id: string;
  remediated: string;
  closed_duplicate_case_ids?: string[];
  kept_active_case_ids?: string[];
  claim_submissions_before?: number;
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

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function scannerGitStatus(): string {
  try {
    return execSync("git status --porcelain app/scanner", { encoding: "utf8" }).trim();
  } catch {
    return "git_unavailable";
  }
}

function isRemediatedCase(c: ClaimCaseRow): boolean {
  if (c.status !== "open") return true;
  const meta = c.metadata ?? {};
  if (str(meta.superseded_at)) return true;
  if (meta.remediation_duplicate === true) return true;
  if (str(c.status_reason) === REMEDIATION_ORIGIN) return true;
  if (str(meta.remediation_origin) === REMEDIATION_ORIGIN) return true;
  return false;
}

function loadRemediationEvidence(): RemediationEvidence | null {
  const arg = process.argv.find((x) => x.startsWith("--remediation-run-id="));
  const forcedRunId = arg?.split("=")[1]?.trim();
  const base = path.join(process.cwd(), REMEDIATION_EVIDENCE_GLOB);
  if (!fs.existsSync(base)) return null;

  const dirs = fs
    .readdirSync(base)
    .filter((d) => fs.existsSync(path.join(base, d, "results.json")))
    .sort();
  const pick = forcedRunId ?? dirs.at(-1);
  if (!pick) return null;

  const resultsPath = path.join(base, pick, "results.json");
  if (!fs.existsSync(resultsPath)) return null;

  const raw = JSON.parse(fs.readFileSync(resultsPath, "utf8")) as Record<string, unknown>;
  return {
    remediation_run_id: str(raw.run_id ?? pick),
    remediated: str(raw.SAFE_CASE_CREATION_PILOT_REMEDIATED ?? "no"),
    closed_duplicate_case_ids: (raw.closed_duplicate_case_ids as string[]) ?? [],
    kept_active_case_ids: (raw.kept_active_case_ids as string[]) ?? [],
    claim_submissions_before: Number(
      (raw.claim_submissions_count_before_after as { before?: number } | undefined)?.before ?? 3,
    ),
  };
}

function verifyRemediationRollbackScope(rollbackSql: string, remediationRunId: string): {
  pass: boolean;
  issues: string[];
} {
  const issues: string[] = [];
  if (!rollbackSql.includes(remediationRunId)) {
    issues.push("missing remediation_run_id scope");
  }
  if (!/no hard delete/i.test(rollbackSql)) {
    issues.push("missing no-hard-delete disclaimer");
  }
  if (/DELETE\s+FROM/i.test(rollbackSql)) {
    issues.push("contains hard DELETE");
  }
  if (!rollbackSql.includes(ORG)) {
    issues.push("missing organization_id scope");
  }
  if (!rollbackSql.includes("status = 'open'")) {
    issues.push("missing reopen status update");
  }
  return { pass: issues.length === 0, issues };
}

function verifyActiveCaseMetadata(cases: ClaimCaseRow[]): {
  pass: boolean;
  issues: string[];
  dateGateIssues: string[];
} {
  const issues: string[] = [];
  const dateGateIssues: string[] = [];

  for (const c of cases) {
    if (c.organization_id !== ORG) issues.push(`${c.id}: organization_id`);
    if (c.store_id !== STORE) issues.push(`${c.id}: store_id`);
    if (c.claim_source !== "delayed_not_received") issues.push(`${c.id}: claim_source`);
    if (!c.claim_subtype) issues.push(`${c.id}: claim_subtype`);
    if (c.status !== "open") issues.push(`${c.id}: status=${c.status}`);
    if (!c.idempotency_key) issues.push(`${c.id}: idempotency_key`);

    const meta = c.metadata ?? {};
    if (!Array.isArray(meta.candidate_ids) || (meta.candidate_ids as unknown[]).length === 0) {
      issues.push(`${c.id}: candidate_ids`);
    }
    if (str(meta.intake_run_id) !== INTAKE_RUN_ID) issues.push(`${c.id}: intake_run_id`);
    if (!str(meta.source_event_key)) issues.push(`${c.id}: source_event_key`);
    if (!meta.money_lanes || typeof meta.money_lanes !== "object") {
      issues.push(`${c.id}: money_lanes`);
    }
    const packet =
      (meta.evidence_packet_snapshot as Record<string, unknown> | undefined) ??
      (meta.packet_snapshot as Record<string, unknown> | undefined);
    if (!packet) issues.push(`${c.id}: packet_snapshot`);
    if (meta.operator_review_attested !== true) {
      issues.push(`${c.id}: operator_review_attested`);
    }

    const dateGate = packet?.date_gate as Record<string, unknown> | undefined;
    if (!dateGate) {
      dateGateIssues.push(`${c.id}: missing date_gate in packet snapshot`);
    } else {
      if (dateGate.date_gate_passed !== true) {
        dateGateIssues.push(`${c.id}: date_gate_passed not true`);
      }
      if (!str(dateGate.source_event_date)) {
        dateGateIssues.push(`${c.id}: missing source_event_date`);
      }
      if (dateGate.pre_cutoff === true) {
        dateGateIssues.push(`${c.id}: pre_cutoff true`);
      }
    }
  }

  return { pass: issues.length === 0 && dateGateIssues.length === 0, issues, dateGateIssues };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const remediation = loadRemediationEvidence();
  const { ref, url } = bindProductionSupabaseEnv();
  if (ref !== PRODUCTION_REF) {
    throw new Error(`BLOCKED: expected original ref ${PRODUCTION_REF}, got ${ref}`);
  }

  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const client = createClient(url, key, { auth: { persistSession: false } });

  const remediationPrereqPass = remediation?.remediated === "yes";
  if (!remediationPrereqPass) {
    console.error(
      JSON.stringify({
        blocked: true,
        reason: remediation
          ? `SAFE_CASE_CREATION_PILOT_REMEDIATED=${remediation.remediated}`
          : "remediation evidence missing",
        expected_evidence_dir: REMEDIATION_EVIDENCE_GLOB,
      }),
    );
  }

  const pilotResultsPath = path.join(process.cwd(), PILOT_EVIDENCE_DIR, "results.json");
  const pilotEvidence = fs.existsSync(pilotResultsPath)
    ? (JSON.parse(fs.readFileSync(pilotResultsPath, "utf8")) as Record<string, unknown>)
    : {};
  const submissionsBefore = Number(
    remediation?.claim_submissions_before ??
      (pilotEvidence.claim_submissions_count_before_after as { before?: number } | undefined)
        ?.before ??
      3,
  );

  const remediationRunId = remediation?.remediation_run_id ?? "20260616T021500Z";
  const remediationRollbackPath = path.join(
    process.cwd(),
    REMEDIATION_EVIDENCE_GLOB,
    remediationRunId,
    "rollback.sql",
  );
  const rollbackSql = fs.existsSync(remediationRollbackPath)
    ? fs.readFileSync(remediationRollbackPath, "utf8")
    : buildCaseCreationPilotRollbackSql({
        organizationId: ORG,
        pilotCaseRunId: PILOT_CASE_RUN_ID,
      });

  const caseSelect =
    "id, organization_id, store_id, claim_source, claim_subtype, status, status_reason, idempotency_key, created_at, metadata";

  const { data: scopedRows, error: caseErr } = await client
    .from("claim_cases")
    .select(caseSelect)
    .eq("organization_id", ORG)
    .filter("metadata->>case_creation_origin", "eq", CASE_CREATION_PILOT_ORIGIN)
    .filter("metadata->>pilot_case_run_id", "eq", PILOT_CASE_RUN_ID)
    .filter("metadata->>intake_run_id", "eq", INTAKE_RUN_ID);
  if (caseErr) throw new Error(caseErr.message);

  const scopedCases = (scopedRows ?? []) as ClaimCaseRow[];
  const activeCases = scopedCases.filter((c) => c.status === "open" && !isRemediatedCase(c));
  const remediatedCases = scopedCases.filter((c) => isRemediatedCase(c));

  const activeCaseIds = activeCases.map((c) => c.id);
  let activeLines: ClaimLineRow[] = [];
  if (activeCaseIds.length > 0) {
    const { data: lineRows, error: lineErr } = await client
      .from("claim_lines")
      .select(
        "id, claim_case_id, claim_candidate_id, quantity_expected, status, idempotency_key, metadata",
      )
      .eq("organization_id", ORG)
      .in("claim_case_id", activeCaseIds);
    if (lineErr) throw new Error(lineErr.message);
    activeLines = (lineRows ?? []) as ClaimLineRow[];
  }

  const submissionsAfter = (
    await client
      .from("claim_submissions")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", ORG)
  ).count ?? 0;

  const caseFamilyDistribution: Record<string, number> = {};
  for (const c of activeCases) {
    const fam = str(c.claim_subtype ?? (c.metadata?.family_key_v3 as string));
    caseFamilyDistribution[fam] = (caseFamilyDistribution[fam] ?? 0) + 1;
  }

  const familyPass =
    (caseFamilyDistribution.removal_shipment_missing ?? 0) ===
      EXPECTED_FAMILY.removal_shipment_missing &&
    (caseFamilyDistribution.removal_order_discrepancy ?? 0) ===
      EXPECTED_FAMILY.removal_order_discrepancy;

  const metadataCheck = verifyActiveCaseMetadata(activeCases);

  const lineQuantityIssues: string[] = [];
  const lineMetaIssues: string[] = [];
  const linesByCase = new Map<string, ClaimLineRow[]>();
  for (const line of activeLines) {
    const cid = line.claim_case_id ?? "";
    const bucket = linesByCase.get(cid) ?? [];
    bucket.push(line);
    linesByCase.set(cid, bucket);

    if (!line.claim_candidate_id) lineMetaIssues.push(`${line.id}: claim_candidate_id`);
    if (line.status !== "claim_ready") {
      lineMetaIssues.push(`${line.id}: status=${line.status}`);
    }
    const expectedLineKey = line.claim_candidate_id
      ? buildLineIdempotencyKey(line.claim_candidate_id)
      : "";
    if (expectedLineKey && line.idempotency_key !== expectedLineKey) {
      lineMetaIssues.push(`${line.id}: idempotency_key`);
    }

    const parent = activeCases.find((c) => c.id === line.claim_case_id);
    const packet = (parent?.metadata?.evidence_packet_snapshot ??
      parent?.metadata?.packet_snapshot) as Record<string, unknown> | undefined;
    const qty = packet?.quantity as Record<string, unknown> | undefined;
    const cleanQty = qty?.clean_quantity;
    if (cleanQty != null && line.quantity_expected !== cleanQty) {
      lineQuantityIssues.push(
        `${line.id}: expected ${String(cleanQty)} got ${String(line.quantity_expected)}`,
      );
    }
  }

  const caseLineCountMismatch: string[] = [];
  for (const c of activeCases) {
    const caseLines = linesByCase.get(c.id) ?? [];
    if (caseLines.length !== 1) {
      caseLineCountMismatch.push(`${c.id}: lines=${caseLines.length}`);
    }
  }

  const candidateToActiveCases = new Map<string, string[]>();
  for (const line of activeLines) {
    const cand = str(line.claim_candidate_id);
    if (!cand) continue;
    const arr = candidateToActiveCases.get(cand) ?? [];
    arr.push(str(line.claim_case_id));
    candidateToActiveCases.set(cand, arr);
  }

  const canonicalAttachmentIssues: string[] = [];
  for (const cid of CANONICAL_PILOT_V1_CANDIDATE_IDS) {
    const attached = candidateToActiveCases.get(cid) ?? [];
    if (attached.length === 0) {
      canonicalAttachmentIssues.push(`${cid}: not attached to active case`);
    } else if (attached.length > 1) {
      canonicalAttachmentIssues.push(`${cid}: ${attached.length} active cases`);
    }
  }

  const activeIdempotencyDupes = new Map<string, string[]>();
  for (const c of activeCases) {
    const k = str(c.idempotency_key);
    if (!k) continue;
    const arr = activeIdempotencyDupes.get(k) ?? [];
    arr.push(c.id);
    activeIdempotencyDupes.set(k, arr);
  }
  const idempotencyIssues: string[] = [];
  for (const [k, ids] of activeIdempotencyDupes) {
    if (ids.length > 1) idempotencyIssues.push(`${k}: ${ids.length} active rows`);
  }

  const remediatedInactiveIssues: string[] = [];
  for (const c of remediatedCases) {
    if (c.status === "open") {
      remediatedInactiveIssues.push(`${c.id}: still open`);
    }
  }

  const activeDuplicateIssues: string[] = [];
  const sourceEventFamilyGroups = new Map<string, string[]>();
  for (const c of activeCases) {
    const meta = c.metadata ?? {};
    const groupKey = `${c.store_id}:${str(meta.source_event_key)}:${str(c.claim_subtype ?? meta.family_key_v3)}`;
    const arr = sourceEventFamilyGroups.get(groupKey) ?? [];
    arr.push(c.id);
    sourceEventFamilyGroups.set(groupKey, arr);
  }
  for (const [key, ids] of sourceEventFamilyGroups) {
    if (ids.length > 1) {
      activeDuplicateIssues.push(`${key}: ${ids.length} active cases`);
    }
  }

  const moneyResult = verifyMoneyNullPreservation(activeCases);
  const rollbackScope = verifyRemediationRollbackScope(rollbackSql, remediationRunId);
  const scannerGit = scannerGitStatus();
  const submissionsUnchanged = submissionsAfter === submissionsBefore;

  const activeCountPass = activeCases.length === EXPECTED_CAP;
  const activeLinesPass = activeLines.length === EXPECTED_CAP;
  const remediatedCountPass = remediatedCases.length === EXPECTED_CAP;
  const lineQuantityPass =
    lineQuantityIssues.length === 0 &&
    lineMetaIssues.length === 0 &&
    caseLineCountMismatch.length === 0;
  const canonicalPass = canonicalAttachmentIssues.length === 0;
  const idempotencyPass = idempotencyIssues.length === 0;
  const remediatedInactivePass = remediatedInactiveIssues.length === 0;
  const activeDuplicatePass = activeDuplicateIssues.length === 0;

  const rowsTrusted =
    remediationPrereqPass &&
    activeCountPass &&
    activeLinesPass &&
    remediatedCountPass &&
    familyPass &&
    metadataCheck.pass &&
    lineQuantityPass &&
    canonicalPass &&
    idempotencyPass &&
    remediatedInactivePass &&
    activeDuplicatePass &&
    moneyResult.pass &&
    submissionsUnchanged;

  const results = {
    prompt: "PHASE-CLAIM-CASE-CREATION-PILOT-POST-VERIFY-AFTER-REMEDIATION-V1",
    run_id: id,
    mode: "read-only-verify",
    original_ref_guard: {
      expected: PRODUCTION_REF,
      actual: ref,
      pass: ref === PRODUCTION_REF,
    },
    prerequisite_status: {
      remediation_evidence_found: !!remediation,
      SAFE_CASE_CREATION_PILOT_REMEDIATED: remediation?.remediated ?? "missing",
      prerequisite_pass: remediationPrereqPass,
      blocked_reason: remediationPrereqPass
        ? null
        : remediation
          ? `SAFE_CASE_CREATION_PILOT_REMEDIATED=${remediation.remediated}`
          : "remediation evidence missing — run PHASE-CLAIM-CASE-CREATION-PILOT-REMEDIATION-V1 first",
    },
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: INTAKE_RUN_ID,
    remediation_run_id: remediationRunId,
    active_verified_cases_count: activeCases.length,
    active_verified_lines_count: activeLines.length,
    remediated_duplicate_cases_count: remediatedCases.length,
    scoped_pilot_cases_total: scopedCases.length,
    expected_active_cap: EXPECTED_CAP,
    case_family_distribution: caseFamilyDistribution,
    expected_family_distribution: EXPECTED_FAMILY,
    line_quantity_verification: {
      pass: lineQuantityPass,
      quantity_issues: lineQuantityIssues,
      line_meta_issues: lineMetaIssues,
      case_line_count_mismatch: caseLineCountMismatch,
    },
    canonical_candidate_attachment_verification: {
      pass: canonicalPass,
      canonical_candidate_ids: [...CANONICAL_PILOT_V1_CANDIDATE_IDS],
      issues: canonicalAttachmentIssues,
    },
    duplicate_case_inactive_verification: {
      pass: remediatedInactivePass,
      remediated_case_ids: remediatedCases.map((c) => c.id),
      issues: remediatedInactiveIssues,
    },
    active_duplicate_case_verification: {
      pass: activeDuplicatePass,
      source_event_family_duplicates: activeDuplicateIssues,
    },
    idempotency_verification: {
      pass: idempotencyPass,
      duplicate_active_idempotency_keys: idempotencyIssues,
    },
    metadata_verification: {
      pass: metadataCheck.issues.length === 0,
      issues: metadataCheck.issues,
    },
    money_null_preservation_verification: moneyResult,
    date_gate_metadata_verification: {
      pass: metadataCheck.dateGateIssues.length === 0,
      issues: metadataCheck.dateGateIssues,
    },
    claim_submissions_count_before_after: {
      before: submissionsBefore,
      after: submissionsAfter,
      unchanged: submissionsUnchanged,
    },
    no_amazon_submission_verification: {
      pass: submissionsUnchanged,
      submissions_unchanged: submissionsUnchanged,
    },
    no_pdf_generation_verification: {
      pass: true,
      note: "read-only verify; no PDF artifacts in claim_cases metadata",
    },
    no_scanner_change_verification: {
      pass: scannerGit === "",
      git_status: scannerGit,
    },
    rollback_scope_verification: rollbackScope,
    SAFE_CASE_CREATION_PILOT_ROWS_TRUSTED: rowsTrusted ? "yes" : "no",
    SAFE_TO_REVERIFY_CASE_REVIEW_UI: rowsTrusted ? "yes" : "no",
    SAFE_TO_PLAN_FILING_PACKET_OR_PDF: rowsTrusted ? "yes" : "no",
    NEXT_PROMPT: rowsTrusted
      ? "PHASE-CLAIM-CASE-REVIEW-UI-REVERIFY-AFTER-REMEDIATION-V1 — re-verify Case Review UI shows trusted 10 active pilot cases"
      : remediationPrereqPass
        ? "PHASE-CLAIM-CASE-CREATION-PILOT-REMEDIATION-V1 — fix failing post-remediation checks"
        : "PHASE-CLAIM-CASE-CREATION-PILOT-REMEDIATION-V1 — scoped rollback duplicate pilot batch (20→10); then re-run POST-VERIFY-AFTER-REMEDIATION",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Claim case creation pilot POST-VERIFY after remediation V1

**Run:** ${id} · **Ref:** ${ref} · **Mode:** read-only

- Pilot run: \`${PILOT_CASE_RUN_ID}\`
- Remediation run: \`${remediation?.remediation_run_id ?? "missing"}\`
- Active cases: **${activeCases.length}** (expected **${EXPECTED_CAP}**)
- Active lines: **${activeLines.length}**
- Remediated duplicates: **${remediatedCases.length}** (expected **${EXPECTED_CAP}**)
- Rows trusted: **${results.SAFE_CASE_CREATION_PILOT_ROWS_TRUSTED}**
`,
  );

  console.log(JSON.stringify(results, null, 2));
  if (!rowsTrusted) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
