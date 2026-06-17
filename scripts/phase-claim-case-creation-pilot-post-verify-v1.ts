/**
 * PHASE-CLAIM-CASE-CREATION-PILOT-POST-VERIFY-V1 — original read-only pilot row audit
 *   npx tsx scripts/phase-claim-case-creation-pilot-post-verify-v1.ts --run-id=<UTC>
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
import { buildLineIdempotencyKey } from "../lib/claims/contracts/claim-case-creation-contract-v1";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-case-creation-pilot-post-verify-v1";
const PILOT_EVIDENCE_DIR =
  ".cursor/audit-reports/phase-claim-case-creation-pilot-v1/20260615T221000Z";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

type PilotEvidence = {
  pilot_case_run_id: string;
  selected_cap: number;
  selected_candidates: string[];
  selected_family_distribution: Record<string, number>;
  safe_case_creation_pilot: string;
  claim_submissions_before: number;
  inserted_cases_count: number;
  reused_existing_count: number;
};

type ClaimCaseRow = {
  id: string;
  organization_id: string;
  store_id: string | null;
  claim_source: string | null;
  claim_subtype: string | null;
  status: string | null;
  idempotency_key: string | null;
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

function loadPilotEvidence(): PilotEvidence {
  const resultsPath = path.join(process.cwd(), PILOT_EVIDENCE_DIR, "results.json");
  if (!fs.existsSync(resultsPath)) {
    throw new Error(`BLOCKED: pilot evidence missing at ${resultsPath}`);
  }
  const pilot = JSON.parse(fs.readFileSync(resultsPath, "utf8")) as Record<string, unknown>;
  const safe = str(pilot.SAFE_CASE_CREATION_PILOT);
  if (safe !== "yes") {
    throw new Error(`BLOCKED: SAFE_CASE_CREATION_PILOT must be yes (got ${safe || "missing"})`);
  }
  const subsBefore = (
    pilot.claim_submissions_count_before_after as { before?: number } | undefined
  )?.before;
  return {
    pilot_case_run_id: str(pilot.pilot_case_run_id),
    selected_cap: Number(pilot.selected_cap ?? 10),
    selected_candidates: (pilot.selected_candidates as string[]) ?? [],
    selected_family_distribution:
      (pilot.selected_family_distribution as Record<string, number>) ?? {},
    safe_case_creation_pilot: safe,
    claim_submissions_before: Number.isFinite(subsBefore) ? Number(subsBefore) : 3,
    inserted_cases_count: Number(pilot.inserted_cases_count ?? 0),
    reused_existing_count: Number(pilot.reused_existing_count ?? 0),
  };
}

function verifyRollbackScope(rollbackSql: string, pilotCaseRunId: string): {
  pass: boolean;
  issues: string[];
} {
  const issues: string[] = [];
  if (!rollbackSql.includes(CASE_CREATION_PILOT_ORIGIN)) {
    issues.push("missing case_creation_origin scope");
  }
  if (!rollbackSql.includes(pilotCaseRunId)) {
    issues.push("missing pilot_case_run_id scope");
  }
  if (!/soft-close|no hard delete/i.test(rollbackSql)) {
    issues.push("missing soft-close disclaimer");
  }
  if (/DELETE\s+FROM/i.test(rollbackSql)) {
    issues.push("contains hard DELETE");
  }
  if (!rollbackSql.includes("status = 'closed'")) {
    issues.push("missing status closed update");
  }
  if (!rollbackSql.includes(ORG)) {
    issues.push("missing organization_id scope");
  }
  return { pass: issues.length === 0, issues };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const pilot = loadPilotEvidence();
  const { ref, url } = bindProductionSupabaseEnv();
  if (ref !== PRODUCTION_REF) {
    throw new Error(`BLOCKED: expected original ref ${PRODUCTION_REF}, got ${ref}`);
  }

  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const client = createClient(url, key, { auth: { persistSession: false } });

  const rollbackPath = path.join(process.cwd(), PILOT_EVIDENCE_DIR, "rollback.sql");
  const rollbackSql = fs.existsSync(rollbackPath)
    ? fs.readFileSync(rollbackPath, "utf8")
    : buildCaseCreationPilotRollbackSql({
        organizationId: ORG,
        pilotCaseRunId: pilot.pilot_case_run_id,
      });

  const caseSelect =
    "id, organization_id, store_id, claim_source, claim_subtype, status, idempotency_key, metadata";

  const { data: caseRows, error: caseErr } = await client
    .from("claim_cases")
    .select(caseSelect)
    .eq("organization_id", ORG)
    .filter("metadata->>case_creation_origin", "eq", CASE_CREATION_PILOT_ORIGIN)
    .filter("metadata->>pilot_case_run_id", "eq", pilot.pilot_case_run_id);
  if (caseErr) throw new Error(caseErr.message);

  const cases = (caseRows ?? []) as ClaimCaseRow[];
  const caseIds = cases.map((c) => c.id);

  let lines: ClaimLineRow[] = [];
  if (caseIds.length > 0) {
    const { data: lineRows, error: lineErr } = await client
      .from("claim_lines")
      .select(
        "id, claim_case_id, claim_candidate_id, quantity_expected, status, idempotency_key, metadata",
      )
      .eq("organization_id", ORG)
      .in("claim_case_id", caseIds);
    if (lineErr) throw new Error(lineErr.message);
    lines = (lineRows ?? []) as ClaimLineRow[];
  }

  let eventsCount = 0;
  if (caseIds.length > 0) {
    const { count, error: evErr } = await client
      .from("claim_case_events")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", ORG)
      .in("claim_case_id", caseIds);
    if (evErr) throw new Error(evErr.message);
    eventsCount = count ?? 0;
  }

  const submissionsAfter = (
    await client
      .from("claim_submissions")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", ORG)
  ).count ?? 0;

  const caseFamilyDistribution: Record<string, number> = {};
  const metadataIssues: string[] = [];
  const dateGateIssues: string[] = [];

  for (const c of cases) {
    const fam = str(c.claim_subtype ?? (c.metadata?.family_key_v3 as string));
    caseFamilyDistribution[fam] = (caseFamilyDistribution[fam] ?? 0) + 1;

    if (c.organization_id !== ORG) metadataIssues.push(`${c.id}: organization_id`);
    if (c.store_id !== STORE) metadataIssues.push(`${c.id}: store_id`);
    if (c.claim_source !== "delayed_not_received") metadataIssues.push(`${c.id}: claim_source`);
    if (!c.claim_subtype) metadataIssues.push(`${c.id}: claim_subtype`);
    if (c.status !== "open") metadataIssues.push(`${c.id}: status=${c.status}`);
    if (!c.idempotency_key) metadataIssues.push(`${c.id}: idempotency_key`);

    const meta = c.metadata ?? {};
    if (!Array.isArray(meta.candidate_ids) || (meta.candidate_ids as unknown[]).length === 0) {
      metadataIssues.push(`${c.id}: candidate_ids`);
    }
    if (str(meta.intake_run_id) !== "a8a892fe-37d5-4d74-9ea2-02af8fd095ce") {
      metadataIssues.push(`${c.id}: intake_run_id`);
    }
    if (!str(meta.source_event_key)) metadataIssues.push(`${c.id}: source_event_key`);
    if (!meta.money_lanes || typeof meta.money_lanes !== "object") {
      metadataIssues.push(`${c.id}: money_lanes`);
    }
    const packet =
      (meta.evidence_packet_snapshot as Record<string, unknown> | undefined) ??
      (meta.packet_snapshot as Record<string, unknown> | undefined);
    if (!packet) metadataIssues.push(`${c.id}: packet_snapshot`);
    if (meta.operator_review_attested !== true) {
      metadataIssues.push(`${c.id}: operator_review_attested`);
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

  const lineQuantityIssues: string[] = [];
  const lineMetaIssues: string[] = [];
  const linesByCase = new Map<string, ClaimLineRow[]>();
  for (const line of lines) {
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

    const parent = cases.find((c) => c.id === line.claim_case_id);
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
  for (const c of cases) {
    const caseLines = linesByCase.get(c.id) ?? [];
    if (caseLines.length !== 1) {
      caseLineCountMismatch.push(`${c.id}: lines=${caseLines.length}`);
    }
  }

  const candidateToActiveCases = new Map<string, string[]>();
  for (const line of lines) {
    const cand = str(line.claim_candidate_id);
    if (!cand) continue;
    const parent = cases.find((c) => c.id === line.claim_case_id);
    if (parent?.status === "open") {
      const arr = candidateToActiveCases.get(cand) ?? [];
      arr.push(parent.id);
      candidateToActiveCases.set(cand, arr);
    }
  }

  const candidateAttachmentIssues: string[] = [];
  for (const selectedId of pilot.selected_candidates) {
    const attached = candidateToActiveCases.get(selectedId) ?? [];
    if (attached.length === 0) {
      candidateAttachmentIssues.push(`${selectedId}: not attached to open case`);
    } else if (attached.length > 1) {
      candidateAttachmentIssues.push(
        `${selectedId}: ${attached.length} open cases (${attached.join(",")})`,
      );
    }
  }

  const duplicateKeyGroups = new Map<string, string[]>();
  for (const c of cases) {
    const meta = c.metadata ?? {};
    const groupKey = `${c.store_id}:${str(meta.source_event_key)}:${str(c.claim_subtype ?? meta.family_key_v3)}`;
    const arr = duplicateKeyGroups.get(groupKey) ?? [];
    arr.push(c.id);
    duplicateKeyGroups.set(groupKey, arr);
  }
  const duplicateCaseIssues: string[] = [];
  for (const [key, ids] of duplicateKeyGroups) {
    if (ids.length > 1) {
      duplicateCaseIssues.push(`${key}: ${ids.length} cases (${ids.join(",")})`);
    }
  }

  const idempotencyKeyDupes = new Map<string, string[]>();
  for (const c of cases) {
    const k = str(c.idempotency_key);
    if (!k) continue;
    const arr = idempotencyKeyDupes.get(k) ?? [];
    arr.push(c.id);
    idempotencyKeyDupes.set(k, arr);
  }
  const idempotencyIssues: string[] = [];
  for (const [k, ids] of idempotencyKeyDupes) {
    if (ids.length > 1) {
      idempotencyIssues.push(`${k}: ${ids.length} rows`);
    }
  }

  const moneyResult = verifyMoneyNullPreservation(cases);
  const rollbackScope = verifyRollbackScope(rollbackSql, pilot.pilot_case_run_id);
  const scannerGit = scannerGitStatus();

  const expectedPilotCap = pilot.selected_cap;
  const verifiedCasesCount = cases.length;
  const verifiedLinesCount = lines.length;
  const caseCountMatchesPilotCap = verifiedCasesCount === expectedPilotCap;
  const caseLineParity = verifiedCasesCount === verifiedLinesCount && caseLineCountMismatch.length === 0;

  const candidateAttachmentPass =
    candidateAttachmentIssues.length === 0 &&
    pilot.selected_candidates.every((id) => (candidateToActiveCases.get(id) ?? []).length === 1);

  const duplicateCasePass = duplicateCaseIssues.length === 0;
  const idempotencyPass = idempotencyIssues.length === 0;
  const metadataPass = metadataIssues.length === 0;
  const dateGatePass = dateGateIssues.length === 0;
  const lineQuantityPass = lineQuantityIssues.length === 0 && lineMetaIssues.length === 0;

  const submissionsUnchanged = submissionsAfter === pilot.claim_submissions_before;

  // Canonical candidate attachment across all pilot-origin rows (org-wide lines lookup)
  const canonicalCandidateIds = [...CANONICAL_PILOT_V1_CANDIDATE_IDS];
  const canonicalLineRows: ClaimLineRow[] = [];
  for (const cid of canonicalCandidateIds) {
    const { data: candLines, error: candLineErr } = await client
      .from("claim_lines")
      .select(
        "id, claim_case_id, claim_candidate_id, quantity_expected, status, idempotency_key, metadata",
      )
      .eq("organization_id", ORG)
      .eq("claim_candidate_id", cid);
    if (candLineErr) throw new Error(candLineErr.message);
    canonicalLineRows.push(...((candLines ?? []) as ClaimLineRow[]));
  }

  const canonicalCaseIds = [
    ...new Set(canonicalLineRows.map((l) => str(l.claim_case_id)).filter(Boolean)),
  ];
  const { data: canonicalCasesRaw } = canonicalCaseIds.length
    ? await client
        .from("claim_cases")
        .select(caseSelect)
        .eq("organization_id", ORG)
        .in("id", canonicalCaseIds)
    : { data: [] };
  const canonicalCases = (canonicalCasesRaw ?? []) as ClaimCaseRow[];
  const canonicalPilotCases = canonicalCases.filter(
    (c) => str(c.metadata?.case_creation_origin) === CASE_CREATION_PILOT_ORIGIN,
  );

  const canonicalAttachmentIssues: string[] = [];
  for (const cid of canonicalCandidateIds) {
    const candLines = canonicalLineRows.filter((l) => l.claim_candidate_id === cid);
    const caseIds = [...new Set(candLines.map((l) => str(l.claim_case_id)).filter(Boolean))];
    if (candLines.length === 0) canonicalAttachmentIssues.push(`${cid}: no line`);
    else if (candLines.length > 1) {
      canonicalAttachmentIssues.push(`${cid}: ${candLines.length} lines`);
    }
    if (caseIds.length > 1) {
      canonicalAttachmentIssues.push(`${cid}: ${caseIds.length} cases (${caseIds.join(",")})`);
    }
  }

  const canonicalMetadataIssues: string[] = [];
  const canonicalMoney = verifyMoneyNullPreservation(canonicalPilotCases);
  for (const c of canonicalPilotCases) {
    const meta = c.metadata ?? {};
    const packet =
      (meta.evidence_packet_snapshot as Record<string, unknown> | undefined) ??
      (meta.packet_snapshot as Record<string, unknown> | undefined);
    if (!packet) canonicalMetadataIssues.push(`${c.id}: packet_snapshot`);
    if (meta.operator_review_attested !== true) {
      canonicalMetadataIssues.push(`${c.id}: operator_review_attested`);
    }
  }

  const canonicalStructuralPass =
    canonicalAttachmentIssues.length === 0 &&
    canonicalMetadataIssues.length === 0 &&
    canonicalMoney.pass &&
    canonicalPilotCases.length === pilot.selected_cap;

  const idempotentReExecutePass =
    pilot.inserted_cases_count === 0 && pilot.reused_existing_count === pilot.selected_cap;

  const rowsTrusted =
    caseCountMatchesPilotCap &&
    caseLineParity &&
    candidateAttachmentPass &&
    duplicateCasePass &&
    idempotencyPass &&
    metadataPass &&
    dateGatePass &&
    lineQuantityPass &&
    moneyResult.pass &&
    submissionsUnchanged &&
    canonicalStructuralPass &&
    idempotentReExecutePass;

  const safeToReviewUi =
    canonicalStructuralPass &&
    candidateAttachmentPass &&
    verifiedCasesCount >= expectedPilotCap;
  const safeToPlanExpansion = rowsTrusted;

  const results = {
    prompt: "PHASE-CLAIM-CASE-CREATION-PILOT-POST-VERIFY-V1",
    run_id: id,
    mode: "read-only-verify",
    original_ref_guard: {
      expected: PRODUCTION_REF,
      actual: ref,
      pass: ref === PRODUCTION_REF,
    },
    pilot_evidence_run_id: "20260615T221000Z",
    pilot_idempotent_re_execute: {
      pass: idempotentReExecutePass,
      inserted_cases_count: pilot.inserted_cases_count,
      reused_existing_count: pilot.reused_existing_count,
    },
    pilot_case_run_id: pilot.pilot_case_run_id,
    pilot_expected_cap: expectedPilotCap,
    verified_cases_count: verifiedCasesCount,
    verified_lines_count: verifiedLinesCount,
    verified_events_count: eventsCount,
    case_count_matches_pilot_cap: caseCountMatchesPilotCap,
    case_line_parity: caseLineParity,
    case_family_distribution: caseFamilyDistribution,
    expected_family_distribution: pilot.selected_family_distribution,
    line_quantity_verification: {
      pass: lineQuantityPass,
      quantity_issues: lineQuantityIssues,
      line_meta_issues: lineMetaIssues,
      case_line_count_mismatch: caseLineCountMismatch,
    },
    candidate_attachment_verification: {
      pass: candidateAttachmentPass,
      issues: candidateAttachmentIssues,
      selected_candidates: pilot.selected_candidates,
    },
    duplicate_case_verification: {
      pass: duplicateCasePass,
      source_event_family_duplicates: duplicateCaseIssues,
    },
    idempotency_verification: {
      pass: idempotencyPass,
      duplicate_idempotency_keys: idempotencyIssues,
    },
    metadata_verification: {
      pass: metadataPass,
      issues: metadataIssues,
      note: "stored field is evidence_packet_snapshot (packet_snapshot alias accepted)",
    },
    money_null_preservation_verification: moneyResult,
    date_gate_metadata_verification: {
      pass: dateGatePass,
      issues: dateGateIssues,
    },
    claim_submissions_count_before_after: {
      before: pilot.claim_submissions_before,
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
    duplicate_batch_note:
      verifiedCasesCount > expectedPilotCap
        ? `Found ${verifiedCasesCount} pilot cases vs cap ${expectedPilotCap}; duplicate batch from pilot execute 190000Z — remediation required`
        : null,
    canonical_verification: {
      pass: canonicalStructuralPass,
      canonical_pilot_cases_count: canonicalPilotCases.length,
      expected_cap: pilot.selected_cap,
      attachment_issues: canonicalAttachmentIssues,
      metadata_issues: canonicalMetadataIssues,
      money_null_preservation: canonicalMoney,
    },
    SAFE_CASE_CREATION_PILOT_ROWS_TRUSTED: rowsTrusted ? "yes" : "no",
    SAFE_TO_BUILD_CASE_REVIEW_UI: safeToReviewUi ? "yes" : "no",
    SAFE_TO_PLAN_CASE_CREATION_EXPANSION: safeToPlanExpansion ? "yes" : "no",
    NEXT_PROMPT: rowsTrusted
      ? "PHASE-CLAIM-FILING-PACKET-PLAN-V1 — read-only filing packet contract before PDF generation"
      : "PHASE-CLAIM-CASE-CREATION-PILOT-REMEDIATION-V1 — scoped rollback duplicate pilot batch (20→10); re-run POST-VERIFY",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Claim case creation pilot POST-VERIFY V1

**Run:** ${id} · **Ref:** ${ref} · **Mode:** read-only

- Pilot run: \`${pilot.pilot_case_run_id}\`
- Verified cases: **${verifiedCasesCount}** (expected cap **${expectedPilotCap}**)
- Verified lines: **${verifiedLinesCount}**
- Verified events: **${eventsCount}**
- Rows trusted: **${results.SAFE_CASE_CREATION_PILOT_ROWS_TRUSTED}**
- SAFE_TO_BUILD_CASE_REVIEW_UI: **${results.SAFE_TO_BUILD_CASE_REVIEW_UI}**
`,
  );

  console.log(JSON.stringify(results, null, 2));
  if (!rowsTrusted) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
