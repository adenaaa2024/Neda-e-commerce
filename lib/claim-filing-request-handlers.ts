/**
 * NEXT-CLAIM-FILING-AGENT-02 — Filing request API handlers (stubs: no external HTTP, no worker).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ClaimAgentConfig } from "../app/settings/workspace-settings-types";
import {
  assertCandidateDraftApprovedForHandoff,
  assertFilingModeAllowsCreate,
  assertStoreAllowedForFiling,
  insertFilingRequestEvent,
  loadGlobalClaimAgentConfig,
  assertWorkItemApprovedForFilingHandoff,
} from "./claim-filing-handoff";
import {
  filingCallbackReplayNonceUsed,
  resolveFilingCallbackHmacSecret,
  verifyFilingCallbackHmac,
} from "./claim-filing-handoff-callback";
import { loadClaimPolicy } from "./claim-eligibility-policy";
import { assertStoreBelongsToOrganization, fetchClaimSubmissionScopeForOrganization } from "./claim-org-scope";
import { isClaimModuleDomainEnabled } from "./claim-module-scope";
import { assertEntitlement } from "./entitlements/resolve-entitlement";
import { isUuidString } from "./uuid";

export type JsonResult = { readonly status: number; readonly body: Record<string, unknown> };

function claimFamilyFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const v = (payload as unknown as Record<string, unknown>).claim_family_key;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function assertClaimFamilyAllowed(config: ClaimAgentConfig, payload: unknown): { ok: true } | { ok: false; error: string } {
  const allow = config.filing_allowed_claim_family_keys;
  if (!allow || allow.length === 0) return { ok: true };
  const key = claimFamilyFromPayload(payload);
  if (!key) return { ok: false, error: "claim_family_key is required in payload when filing_allowed_claim_family_keys is set." };
  if (!allow.includes(key)) return { ok: false, error: "claim_family_key is not in filing_allowed_claim_family_keys." };
  return { ok: true };
}

export async function createClaimFilingRequest(args: {
  readonly supabase: SupabaseClient;
  readonly userId: string;
  readonly body: Record<string, unknown>;
}): Promise<JsonResult> {
  const organizationId = String(args.body.organization_id ?? "").trim();
  const storeId = String(args.body.store_id ?? "").trim();
  const idempotencyKey = String(args.body.idempotency_key ?? "").trim();
  const workItemIdRaw = args.body.claim_review_work_item_id;
  const draftIdRaw = args.body.claim_candidate_draft_id;
  const submissionIdRaw = args.body.claim_submission_id;
  const operatorReadyAck = args.body.operator_ready_ack === true;
  const payload = args.body.payload;

  if (!isUuidString(organizationId)) return { status: 400, body: { error: "organization_id must be a UUID." } };
  if (!isUuidString(storeId)) return { status: 400, body: { error: "store_id must be a UUID." } };
  if (!idempotencyKey || idempotencyKey.length > 512) {
    return { status: 400, body: { error: "idempotency_key is required (max 512 chars)." } };
  }

  const storeOk = await assertStoreBelongsToOrganization(organizationId, storeId);
  if (!storeOk.ok) return { status: storeOk.status, body: { error: storeOk.error } };

  const claimPolicy = await loadClaimPolicy(args.supabase, organizationId);
  if (!isClaimModuleDomainEnabled(claimPolicy, "marketplace")) {
    return {
      status: 403,
      body: { error: "Marketplace claim filing is disabled for this organization (module scope)." },
    };
  }

  const ent = assertEntitlement("claims.filing.handoff", {
    organizationId,
    storeId,
    userId: args.userId,
  });
  if (!ent.ok) return { status: 403, body: { error: "Filing handoff is not entitled for this store.", decision: ent } };

  const config = await loadGlobalClaimAgentConfig(args.supabase);
  const modeOk = assertFilingModeAllowsCreate(config.filing_automation_mode);
  if (!modeOk.ok) return { status: 400, body: { error: modeOk.error } };

  const storeAllow = assertStoreAllowedForFiling(storeId, config);
  if (!storeAllow.ok) return { status: 400, body: { error: storeAllow.error } };

  const famOk = assertClaimFamilyAllowed(config, payload);
  if (!famOk.ok) return { status: 400, body: { error: famOk.error } };

  const { data: existing, error: exErr } = await args.supabase
    .from("claim_filing_requests")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (exErr) return { status: 500, body: { error: exErr.message } };
  if (existing) {
    return { status: 200, body: { filing_request: existing, idempotent: true } };
  }

  const workItemId =
    typeof workItemIdRaw === "string" && isUuidString(workItemIdRaw.trim()) ? workItemIdRaw.trim() : null;
  const draftIdIn =
    typeof draftIdRaw === "string" && isUuidString(draftIdRaw.trim()) ? draftIdRaw.trim() : null;
  const submissionId =
    typeof submissionIdRaw === "string" && isUuidString(submissionIdRaw.trim()) ? submissionIdRaw.trim() : null;

  let resolvedWorkItemId: string | null = null;
  let resolvedDraftId: string | null = null;

  if (workItemId) {
    const g = await assertWorkItemApprovedForFilingHandoff({
      supabase: args.supabase,
      organizationId,
      storeId,
      workItemId,
      operatorReadyAck,
    });
    if (!g.ok) return { status: g.status, body: { error: g.error } };
    resolvedWorkItemId = g.workItemId;
    resolvedDraftId = g.draftId;
    if (draftIdIn && draftIdIn !== resolvedDraftId) {
      return { status: 400, body: { error: "claim_candidate_draft_id does not match the work item draft." } };
    }
  } else if (draftIdIn) {
    const g = await assertCandidateDraftApprovedForHandoff({
      supabase: args.supabase,
      organizationId,
      storeId,
      draftId: draftIdIn,
      operatorReadyAck,
    });
    if (!g.ok) return { status: g.status, body: { error: g.error } };
    resolvedDraftId = g.draftId;
  } else if (submissionId) {
    const scope = await fetchClaimSubmissionScopeForOrganization(submissionId, organizationId);
    if (!scope.ok) return { status: scope.status, body: { error: scope.error } };
    const sid = String(scope.store_id ?? "").trim();
    if (sid !== storeId) {
      return { status: 400, body: { error: "store_id must match the submission's store for submission-anchored requests." } };
    }
    const st = String(scope.status ?? "").trim();
    if (st !== "ready_to_send" && st !== "submitted") {
      return {
        status: 400,
        body: {
          error:
            "Submission-anchored filing requests require claim_submissions.status of ready_to_send or submitted.",
        },
      };
    }
  } else {
    return {
      status: 400,
      body: {
        error: "Provide claim_review_work_item_id, claim_candidate_draft_id, or claim_submission_id.",
      },
    };
  }

  const automationMode = String(config.filing_automation_mode ?? "disabled");
  const initialStatus = automationMode === "manual_only" ? "draft" : "pending_approval";
  const safePayload =
    payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as unknown as Record<string, unknown>) : {};

  const insertRow: Record<string, unknown> = {
    organization_id: organizationId,
    store_id: storeId,
    claim_review_work_item_id: resolvedWorkItemId,
    claim_candidate_draft_id: resolvedDraftId,
    claim_submission_id: submissionId,
    idempotency_key: idempotencyKey,
    automation_mode: automationMode,
    status: initialStatus,
    payload: safePayload,
    requested_by: args.userId,
    environment: config.filing_environment ?? "sandbox",
    external_agent_endpoint: config.filing_external_agent_endpoint ?? null,
    secret_reference: config.filing_external_agent_secret_ref ?? null,
    callback_secret_reference: config.filing_callback_secret_ref ?? null,
    agent_timeout_ms: config.filing_agent_timeout_ms ?? null,
    agent_max_retries: config.filing_agent_max_retries ?? null,
  };

  const { data: created, error: insErr } = await args.supabase
    .from("claim_filing_requests")
    .insert(insertRow)
    .select("*")
    .maybeSingle();
  if (insErr) {
    if (String(insErr.message).includes("duplicate") || String(insErr.code) === "23505") {
      const { data: again } = await args.supabase
        .from("claim_filing_requests")
        .select("*")
        .eq("organization_id", organizationId)
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();
      if (again) return { status: 200, body: { filing_request: again, idempotent: true } };
    }
    return { status: 500, body: { error: insErr.message } };
  }
  if (!created) return { status: 500, body: { error: "Insert did not return a row." } };

  const frId = String((created as { id?: string }).id ?? "");
  if (isUuidString(frId)) {
    await insertFilingRequestEvent(args.supabase, {
      filingRequestId: frId,
      organizationId,
      eventType: "created",
      actorUserId: args.userId,
      source: "app",
      payload: { idempotency_key: idempotencyKey, initial_status: initialStatus },
    });
  }

  return { status: 201, body: { filing_request: created } };
}

export async function getClaimFilingRequest(args: {
  readonly supabase: SupabaseClient;
  readonly userId: string;
  readonly filingRequestId: string;
  readonly organizationId: string;
  readonly storeId: string;
  readonly includeEvents?: boolean;
}): Promise<JsonResult> {
  if (!isUuidString(args.filingRequestId) || !isUuidString(args.organizationId) || !isUuidString(args.storeId)) {
    return { status: 400, body: { error: "filingRequestId, organization_id, and store_id must be UUIDs." } };
  }

  const storeOk = await assertStoreBelongsToOrganization(args.organizationId, args.storeId);
  if (!storeOk.ok) return { status: storeOk.status, body: { error: storeOk.error } };

  const ent = assertEntitlement("claims.filing.handoff", {
    organizationId: args.organizationId,
    storeId: args.storeId,
    userId: args.userId,
  });
  if (!ent.ok) return { status: 403, body: { error: "Filing handoff is not entitled for this store.", decision: ent } };

  const { data: row, error } = await args.supabase
    .from("claim_filing_requests")
    .select("*")
    .eq("id", args.filingRequestId)
    .eq("organization_id", args.organizationId)
    .maybeSingle();
  if (error) return { status: 500, body: { error: error.message } };
  if (!row) return { status: 404, body: { error: "Filing request not found." } };
  if (String((row as { store_id?: string }).store_id ?? "").trim() !== args.storeId) {
    return { status: 400, body: { error: "store_id does not match this filing request." } };
  }

  let events: unknown[] | undefined;
  if (args.includeEvents) {
    const { data: ev, error: eErr } = await args.supabase
      .from("claim_filing_request_events")
      .select("id, event_type, actor_user_id, source, payload, created_at")
      .eq("filing_request_id", args.filingRequestId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (eErr) return { status: 500, body: { error: eErr.message } };
    events = ev ?? [];
  }

  return { status: 200, body: { filing_request: row, events } };
}

export async function approveClaimFilingRequest(args: {
  readonly supabase: SupabaseClient;
  readonly userId: string;
  readonly filingRequestId: string;
  readonly organizationId: string;
  readonly storeId: string;
}): Promise<JsonResult> {
  if (!isUuidString(args.filingRequestId) || !isUuidString(args.organizationId) || !isUuidString(args.storeId)) {
    return { status: 400, body: { error: "filingRequestId, organization_id, and store_id must be UUIDs." } };
  }

  const storeOk = await assertStoreBelongsToOrganization(args.organizationId, args.storeId);
  if (!storeOk.ok) return { status: storeOk.status, body: { error: storeOk.error } };

  const ent = assertEntitlement("claims.filing.handoff", {
    organizationId: args.organizationId,
    storeId: args.storeId,
    userId: args.userId,
  });
  if (!ent.ok) return { status: 403, body: { error: "Filing handoff is not entitled for this store.", decision: ent } };

  const { data: row, error } = await args.supabase
    .from("claim_filing_requests")
    .select("*")
    .eq("id", args.filingRequestId)
    .eq("organization_id", args.organizationId)
    .maybeSingle();
  if (error) return { status: 500, body: { error: error.message } };
  if (!row) return { status: 404, body: { error: "Filing request not found." } };
  if (String((row as { store_id?: string }).store_id ?? "").trim() !== args.storeId) {
    return { status: 400, body: { error: "store_id does not match this filing request." } };
  }

  const status = String((row as { status?: string }).status ?? "");
  if (status === "approved" || status === "queued" || status === "terminal_success") {
    return { status: 200, body: { filing_request: row, idempotent: true } };
  }
  if (status !== "draft" && status !== "pending_approval") {
    return { status: 409, body: { error: `Filing request cannot be approved from status '${status}'.` } };
  }

  const nowIso = new Date().toISOString();
  const { data: updated, error: uErr } = await args.supabase
    .from("claim_filing_requests")
    .update({
      status: "approved",
      approved_by: args.userId,
      approved_at: nowIso,
    })
    .eq("id", args.filingRequestId)
    .in("status", ["draft", "pending_approval"])
    .select("*")
    .maybeSingle();

  if (uErr) return { status: 500, body: { error: uErr.message } };

  if (!updated) {
    const { data: again } = await args.supabase
      .from("claim_filing_requests")
      .select("*")
      .eq("id", args.filingRequestId)
      .maybeSingle();
    if (again && ["approved", "queued", "terminal_success"].includes(String((again as { status?: string }).status))) {
      return { status: 200, body: { filing_request: again, idempotent: true } };
    }
    return { status: 409, body: { error: "Approve raced or status changed; retry GET." } };
  }

  await insertFilingRequestEvent(args.supabase, {
    filingRequestId: args.filingRequestId,
    organizationId: args.organizationId,
    eventType: "approved",
    actorUserId: args.userId,
    source: "app",
    payload: { approved_at: nowIso },
  });

  return { status: 200, body: { filing_request: updated } };
}

export async function receiveClaimFilingCallback(args: {
  readonly supabase: SupabaseClient;
  readonly filingRequestId: string;
  readonly rawBody: string;
  readonly signatureHeader: string | null;
  readonly timestampHeader: string | null;
}): Promise<JsonResult> {
  if (!isUuidString(args.filingRequestId)) {
    return { status: 400, body: { error: "filingRequestId must be a UUID." } };
  }

  let parsed: Record<string, unknown>;
  try {
    const j = JSON.parse(args.rawBody) as unknown;
    if (!j || typeof j !== "object" || Array.isArray(j)) {
      return { status: 400, body: { error: "Callback body must be a JSON object." } };
    }
    parsed = j as unknown as Record<string, unknown>;
  } catch {
    return { status: 400, body: { error: "Invalid JSON body." } };
  }

  const bodyFrId = String(parsed.filing_request_id ?? "").trim();
  if (bodyFrId !== args.filingRequestId) {
    return { status: 400, body: { error: "filing_request_id in body must match the URL id." } };
  }

  const { data: row, error } = await args.supabase
    .from("claim_filing_requests")
    .select("*")
    .eq("id", args.filingRequestId)
    .maybeSingle();
  if (error) return { status: 500, body: { error: error.message } };
  if (!row) return { status: 404, body: { error: "Filing request not found." } };

  const orgId = String((row as { organization_id?: string }).organization_id ?? "");
  const secret = resolveFilingCallbackHmacSecret(
    (row as { callback_secret_reference?: string | null }).callback_secret_reference,
  );
  if (!secret) {
    return {
      status: 503,
      body: { error: "Callback HMAC secret is not configured (CLAIM_FILING_CALLBACK_SECRET or env ref)." },
    };
  }

  const v = verifyFilingCallbackHmac({
    secret,
    rawBody: args.rawBody,
    signatureHeader: args.signatureHeader,
    timestampHeader: args.timestampHeader,
  });
  if (!v.ok) return { status: v.status, body: { error: v.error } };

  const replayNonce = typeof parsed.replay_nonce === "string" ? parsed.replay_nonce : null;
  if (replayNonce) {
    const seen = await filingCallbackReplayNonceUsed(args.supabase, args.filingRequestId, replayNonce);
    if (seen) return { status: 409, body: { error: "replay_nonce already processed for this filing request." } };
  }

  const outcome = String(parsed.outcome ?? "").trim().toLowerCase();
  if (outcome !== "success" && outcome !== "failure") {
    return { status: 400, body: { error: "outcome must be 'success' or 'failure'." } };
  }

  const currentStatus = String((row as { status?: string }).status ?? "");
  if (currentStatus === "terminal_success" || currentStatus === "terminal_failure") {
    return { status: 200, body: { filing_request: row, idempotent: true } };
  }
  if (currentStatus !== "approved" && currentStatus !== "queued") {
    return { status: 409, body: { error: "Callback rejected: filing request is not approved for agent callbacks." } };
  }

  const externalCaseId =
    typeof parsed.external_case_id === "string" && parsed.external_case_id.trim()
      ? parsed.external_case_id.trim()
      : null;
  const submissionStatus =
    typeof parsed.submission_status === "string" && parsed.submission_status.trim()
      ? parsed.submission_status.trim()
      : null;
  const failureReason =
    typeof parsed.failure_reason === "string" && parsed.failure_reason.trim()
      ? parsed.failure_reason.trim()
      : null;
  const failureCategory =
    typeof parsed.failure_category === "string" && parsed.failure_category.trim()
      ? parsed.failure_category.trim()
      : null;

  let artifactRefs: unknown = (row as { artifact_refs?: unknown }).artifact_refs;
  if (parsed.artifact_refs != null) artifactRefs = parsed.artifact_refs;

  const nextStatus = outcome === "success" ? "terminal_success" : "terminal_failure";

  const { data: updated, error: uErr } = await args.supabase
    .from("claim_filing_requests")
    .update({
      status: nextStatus,
      external_case_id: externalCaseId ?? (row as { external_case_id?: string | null }).external_case_id,
      submission_status: submissionStatus ?? (row as { submission_status?: string | null }).submission_status,
      failure_reason: failureReason ?? (row as { failure_reason?: string | null }).failure_reason,
      failure_category: failureCategory ?? (row as { failure_category?: string | null }).failure_category,
      artifact_refs: artifactRefs ?? [],
    })
    .eq("id", args.filingRequestId)
    .in("status", ["approved", "queued"])
    .select("*")
    .maybeSingle();

  if (uErr) return { status: 500, body: { error: uErr.message } };
  if (!updated) {
    const { data: again } = await args.supabase
      .from("claim_filing_requests")
      .select("*")
      .eq("id", args.filingRequestId)
      .maybeSingle();
    if (
      again &&
      (String((again as { status?: string }).status) === "terminal_success" ||
        String((again as { status?: string }).status) === "terminal_failure")
    ) {
      return { status: 200, body: { filing_request: again, idempotent: true } };
    }
    return { status: 409, body: { error: "Callback raced or filing request not in approved state." } };
  }

  await insertFilingRequestEvent(args.supabase, {
    filingRequestId: args.filingRequestId,
    organizationId: orgId,
    eventType: "callback_received",
    actorUserId: null,
    source: "callback",
    payload: {
      outcome,
      external_case_id: externalCaseId,
      replay_nonce: replayNonce,
      filing_callback_ts: v.timestampMs,
    },
  });

  return { status: 200, body: { filing_request: updated } };
}
