/**
 * PHASE-CLAIM-CASE-CREATION-PILOT-REMEDIATION-V1
 * Soft-close duplicate scoped pilot cases; retain canonical 10.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  CANONICAL_PILOT_V1_CANDIDATE_IDS,
  CASE_CREATION_PILOT_ORIGIN,
} from "./claim-case-creation-pilot-v1";
import { ORIGINAL_PILOT_INTAKE_RUN_ID } from "@/lib/claims/evidence/claim-evidence-packet-v1-plan-contract";

export const REMEDIATION_ORIGIN = "case_creation_pilot_duplicate_remediation_v1" as const;
export const REMEDIATION_REASON = "duplicate_pilot_batch" as const;
export const DEFAULT_PILOT_CASE_RUN_ID = "pilot-20260615T190000Z" as const;

const APPROVAL_FILE = join(
  process.cwd(),
  ".cursor/operator-approvals/claim-case-creation-pilot-remediation-v1-approval.md",
);

export type PilotRemediationApprovalStatus = {
  approved: boolean;
  status: "signed" | "unsigned";
  reason: string | null;
};

export type ScopedPilotCaseRow = {
  id: string;
  status: string | null;
  claim_subtype: string | null;
  created_at: string | null;
  idempotency_key: string | null;
  metadata: Record<string, unknown> | null;
};

export type ScopedPilotLineRow = {
  id: string;
  claim_case_id: string | null;
  claim_candidate_id: string | null;
  status: string | null;
  idempotency_key: string | null;
  metadata: Record<string, unknown> | null;
};

export type PilotRemediationPlan = {
  pilot_case_run_id: string;
  intake_run_id: string;
  canonical_candidate_ids: string[];
  retained_case_ids: string[];
  duplicate_case_ids: string[];
  duplicate_line_ids: string[];
  retained_by_candidate: Record<string, string>;
  family_distribution_active_before: Record<string, number>;
};

export type PilotRemediationExecuteResult = {
  remediation_run_id: string;
  plan: PilotRemediationPlan;
  cases_remediated: number;
  lines_remediated: number;
  events_inserted: number;
};

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function metaRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function readPilotRemediationApprovalStatus(): PilotRemediationApprovalStatus {
  if (!existsSync(APPROVAL_FILE)) {
    return { approved: false, status: "unsigned", reason: "approval_file_missing" };
  }
  const text = readFileSync(APPROVAL_FILE, "utf8");
  if (!/APPROVED_CLAIM_CASE_CREATION_PILOT_REMEDIATION_V1\s*=\s*yes/i.test(text)) {
    return {
      approved: false,
      status: "unsigned",
      reason: "APPROVED_CLAIM_CASE_CREATION_PILOT_REMEDIATION_V1_not_yes",
    };
  }
  return { approved: true, status: "signed", reason: null };
}

export function familyDistribution(
  cases: Array<{ claim_subtype: string | null; metadata: Record<string, unknown> | null; status: string | null }>,
  activeOnly = true,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of cases) {
    if (activeOnly && c.status !== "open") continue;
    const fam = str(c.claim_subtype ?? c.metadata?.family_key_v3);
    if (!fam) continue;
    out[fam] = (out[fam] ?? 0) + 1;
  }
  return out;
}

export async function planPilotDuplicateRemediation(
  client: SupabaseClient,
  organizationId: string,
  options: {
    pilot_case_run_id?: string;
    intake_run_id?: string;
  } = {},
): Promise<PilotRemediationPlan> {
  const pilotCaseRunId = str(options.pilot_case_run_id) || DEFAULT_PILOT_CASE_RUN_ID;
  const intakeRunId = str(options.intake_run_id) || ORIGINAL_PILOT_INTAKE_RUN_ID;

  const { data: caseRows, error: caseErr } = await client
    .from("claim_cases")
    .select("id, status, claim_subtype, created_at, idempotency_key, metadata")
    .eq("organization_id", organizationId)
    .filter("metadata->>case_creation_origin", "eq", CASE_CREATION_PILOT_ORIGIN)
    .filter("metadata->>pilot_case_run_id", "eq", pilotCaseRunId)
    .filter("metadata->>intake_run_id", "eq", intakeRunId);
  if (caseErr) throw new Error(caseErr.message);

  const scopedCases = (caseRows ?? []) as ScopedPilotCaseRow[];
  const scopedCaseIds = scopedCases.map((c) => c.id);

  let scopedLines: ScopedPilotLineRow[] = [];
  if (scopedCaseIds.length > 0) {
    const { data: lineRows, error: lineErr } = await client
      .from("claim_lines")
      .select("id, claim_case_id, claim_candidate_id, status, idempotency_key, metadata")
      .eq("organization_id", organizationId)
      .in("claim_case_id", scopedCaseIds);
    if (lineErr) throw new Error(lineErr.message);
    scopedLines = (lineRows ?? []) as ScopedPilotLineRow[];
  }

  const caseById = new Map(scopedCases.map((c) => [c.id, c]));
  const retainedByCandidate: Record<string, string> = {};
  const retainedCaseIds = new Set<string>();
  const duplicateCaseIds = new Set<string>();

  for (const candidateId of CANONICAL_PILOT_V1_CANDIDATE_IDS) {
    const linkedCaseIds = [
      ...new Set(
        scopedLines
          .filter((l) => l.claim_candidate_id === candidateId)
          .map((l) => str(l.claim_case_id))
          .filter(Boolean),
      ),
    ];
    const openLinked = linkedCaseIds
      .map((id) => caseById.get(id))
      .filter((c): c is ScopedPilotCaseRow => !!c && c.status === "open")
      .sort((a, b) => str(a.created_at).localeCompare(str(b.created_at)));

    if (openLinked.length === 0) {
      throw new Error(`canonical_candidate_no_open_case:${candidateId}`);
    }

    const keep = openLinked[0]!;
    retainedByCandidate[candidateId] = keep.id;
    retainedCaseIds.add(keep.id);

    for (const dup of openLinked.slice(1)) {
      duplicateCaseIds.add(dup.id);
    }
  }

  for (const c of scopedCases) {
    if (c.status === "open" && !retainedCaseIds.has(c.id)) {
      duplicateCaseIds.add(c.id);
    }
  }

  const duplicateLineIds = scopedLines
    .filter((l) => duplicateCaseIds.has(str(l.claim_case_id)))
    .map((l) => l.id);

  return {
    pilot_case_run_id: pilotCaseRunId,
    intake_run_id: intakeRunId,
    canonical_candidate_ids: [...CANONICAL_PILOT_V1_CANDIDATE_IDS],
    retained_case_ids: [...retainedCaseIds],
    duplicate_case_ids: [...duplicateCaseIds],
    duplicate_line_ids: duplicateLineIds,
    retained_by_candidate: retainedByCandidate,
    family_distribution_active_before: familyDistribution(scopedCases, true),
  };
}

export function buildPilotRemediationRollbackSql(args: {
  organizationId: string;
  remediationRunId: string;
}): string {
  const org = args.organizationId;
  const runId = args.remediationRunId;
  return `-- PHASE-CLAIM-CASE-CREATION-PILOT-REMEDIATION-V1 rollback (reopen remediated rows only; no hard delete)
-- Scope: metadata.remediation_run_id = '${runId}'

BEGIN;

UPDATE public.claim_lines cl
SET
  status = 'claim_ready',
  status_reason = NULL,
  metadata = COALESCE(cl.metadata, '{}'::jsonb)
    - 'remediation_origin'
    - 'remediation_run_id'
    - 'remediated_at'
    - 'remediation_reason'
    - 'retained_canonical_case_id'
    - 'remediation_rollback_at',
  updated_at = now()
WHERE cl.organization_id = '${org}'::uuid
  AND cl.metadata->>'remediation_run_id' = '${runId}';

UPDATE public.claim_cases cc
SET
  status = 'open',
  status_reason = NULL,
  closed_at = NULL,
  metadata = COALESCE(cc.metadata, '{}'::jsonb)
    - 'remediation_origin'
    - 'remediation_run_id'
    - 'remediated_at'
    - 'remediation_reason'
    - 'retained_canonical_case_id'
    - 'remediation_duplicate'
    - 'superseded_at'
    - 'remediation_rollback_at',
  updated_at = now()
WHERE cc.organization_id = '${org}'::uuid
  AND cc.metadata->>'remediation_run_id' = '${runId}';

INSERT INTO public.claim_case_events (
  organization_id,
  claim_case_id,
  event_type,
  from_status,
  to_status,
  payload
)
SELECT
  organization_id,
  id,
  'status_changed',
  'closed',
  'open',
  jsonb_build_object(
    'rollback', 'pilot_remediation_rollback_v1',
    'remediation_run_id', '${runId}'
  )
FROM public.claim_cases
WHERE organization_id = '${org}'::uuid
  AND metadata->>'remediation_run_id' = '${runId}'
  AND status = 'open';

COMMIT;
`;
}

export async function executePilotDuplicateRemediation(
  client: SupabaseClient,
  organizationId: string,
  remediationRunId: string,
  plan: PilotRemediationPlan,
): Promise<PilotRemediationExecuteResult> {
  const remediatedAt = new Date().toISOString();
  let casesRemediated = 0;
  let linesRemediated = 0;
  let eventsInserted = 0;

  const lineToRetainedCase = new Map<string, string>();
  for (const lineId of plan.duplicate_line_ids) {
    const line = (
      await client
        .from("claim_lines")
        .select("id, claim_case_id, claim_candidate_id, metadata")
        .eq("id", lineId)
        .maybeSingle()
    ).data as ScopedPilotLineRow | null;
    if (!line) continue;
    const cand = str(line.claim_candidate_id);
    const retained = plan.retained_by_candidate[cand] ?? null;
    if (retained) lineToRetainedCase.set(lineId, retained);
  }

  for (const lineId of plan.duplicate_line_ids) {
    const retainedCaseId = lineToRetainedCase.get(lineId) ?? null;
    const { data: existing, error: readErr } = await client
      .from("claim_lines")
      .select("metadata, status")
      .eq("id", lineId)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!existing || existing.status === "closed") continue;

    const priorMeta = metaRecord(existing.metadata);
    const { error: lineErr } = await client
      .from("claim_lines")
      .update({
        status: "closed",
        status_reason: REMEDIATION_ORIGIN,
        metadata: {
          ...priorMeta,
          remediation_origin: REMEDIATION_ORIGIN,
          remediation_run_id: remediationRunId,
          remediated_at: remediatedAt,
          remediation_reason: REMEDIATION_REASON,
          ...(retainedCaseId ? { retained_canonical_case_id: retainedCaseId } : {}),
        },
        updated_at: remediatedAt,
      })
      .eq("id", lineId);
    if (lineErr) throw new Error(`line_remediation_failed:${lineErr.message}`);
    linesRemediated += 1;
  }

  for (const caseId of plan.duplicate_case_ids) {
    const { data: existing, error: readErr } = await client
      .from("claim_cases")
      .select("metadata, status")
      .eq("id", caseId)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!existing || existing.status === "closed") continue;

    const priorMeta = metaRecord(existing.metadata);
    const candIds = Array.isArray(priorMeta.candidate_ids)
      ? (priorMeta.candidate_ids as unknown[]).map((x) => str(x)).filter(Boolean)
      : [];
    const retainedCaseId =
      candIds.map((cid) => plan.retained_by_candidate[cid]).find(Boolean) ?? null;

    const { error: caseErr } = await client
      .from("claim_cases")
      .update({
        status: "closed",
        status_reason: REMEDIATION_ORIGIN,
        closed_at: remediatedAt,
        metadata: {
          ...priorMeta,
          remediation_origin: REMEDIATION_ORIGIN,
          remediation_run_id: remediationRunId,
          remediated_at: remediatedAt,
          remediation_reason: REMEDIATION_REASON,
          remediation_duplicate: true,
          superseded_at: remediatedAt,
          ...(retainedCaseId ? { retained_canonical_case_id: retainedCaseId } : {}),
        },
        updated_at: remediatedAt,
      })
      .eq("id", caseId);
    if (caseErr) throw new Error(`case_remediation_failed:${caseErr.message}`);
    casesRemediated += 1;

    const { error: evErr } = await client.from("claim_case_events").insert({
      organization_id: organizationId,
      claim_case_id: caseId,
      event_type: "case_closed",
      from_status: "open",
      to_status: "closed",
      payload: {
        remediation_origin: REMEDIATION_ORIGIN,
        remediation_run_id: remediationRunId,
        remediation_reason: REMEDIATION_REASON,
        retained_canonical_case_id: retainedCaseId,
      },
    });
    if (evErr) throw new Error(`case_event_insert_failed:${evErr.message}`);
    eventsInserted += 1;
  }

  return {
    remediation_run_id: remediationRunId,
    plan,
    cases_remediated: casesRemediated,
    lines_remediated: linesRemediated,
    events_inserted: eventsInserted,
  };
}
