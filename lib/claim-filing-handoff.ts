/**
 * NEXT-CLAIM-FILING-AGENT-02 — Filing handoff helpers (no worker, no external HTTP).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { isClaimDraftsReviewEnabled } from "./claim-drafts-api";
import { isClaimReviewWorkflowEnabled } from "./claim-review-workflow";
import type { ClaimAgentConfig } from "../app/settings/workspace-settings-types";
import { DEFAULT_CLAIM_AGENT_CONFIG } from "../app/settings/workspace-settings-types";
import { isUuidString } from "./uuid";

export type FilingAutomationMode = ClaimAgentConfig["filing_automation_mode"];

export function isClaimFilingHandoffEnabled(): boolean {
  const v = process.env.ENABLE_CLAIM_FILING_HANDOFF?.trim().toLowerCase();
  return v === "true" || v === "1";
}

export function isClaimFilingHandoffApiActive(): boolean {
  return isClaimDraftsReviewEnabled() && isClaimReviewWorkflowEnabled() && isClaimFilingHandoffEnabled();
}

export function mergeClaimAgentFilingConfig(raw: unknown): ClaimAgentConfig {
  const base = { ...DEFAULT_CLAIM_AGENT_CONFIG };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const o = raw as unknown as Record<string, unknown>;
  const out: ClaimAgentConfig = { ...base, ...(o as ClaimAgentConfig) };
  const allowedModes = new Set<string>([
    "disabled",
    "manual_only",
    "prepare_only",
    "submit_with_confirmation",
    "full_auto_reserved",
  ]);
  const m = out.filing_automation_mode;
  if (m == null || !allowedModes.has(String(m))) out.filing_automation_mode = "disabled";
  const env = out.filing_environment;
  if (env !== "sandbox" && env !== "production") out.filing_environment = "sandbox";
  return out;
}

export async function loadGlobalClaimAgentConfig(supabase: SupabaseClient): Promise<ClaimAgentConfig> {
  const { data, error } = await supabase
    .from("workspace_settings")
    .select("module_configs")
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error || !data) return { ...DEFAULT_CLAIM_AGENT_CONFIG };
  const mc = (data as { module_configs?: unknown }).module_configs;
  if (!mc || typeof mc !== "object" || Array.isArray(mc)) return { ...DEFAULT_CLAIM_AGENT_CONFIG };
  const claim = (mc as { claim_agent_config?: unknown }).claim_agent_config;
  return mergeClaimAgentFilingConfig(claim);
}

export function assertStoreAllowedForFiling(
  storeId: string,
  config: ClaimAgentConfig,
): { ok: true } | { ok: false; error: string } {
  const ids = config.filing_allowed_store_ids;
  if (!ids || ids.length === 0) return { ok: true };
  if (ids.includes(storeId)) return { ok: true };
  return { ok: false, error: "Store is not in filing_allowed_store_ids for this workspace." };
}

export function assertFilingModeAllowsCreate(mode: FilingAutomationMode | undefined): { ok: true } | { ok: false; error: string } {
  const m = mode ?? "disabled";
  if (m === "disabled") return { ok: false, error: "Filing automation is disabled for this workspace (claim_agent_config.filing_automation_mode)." };
  if (m === "full_auto_reserved") return { ok: false, error: "Full-auto filing is reserved and not enabled." };
  return { ok: true };
}

export type WorkItemDraftGate =
  | {
      ok: true;
      workItemId: string | null;
      draftId: string;
      draftLifecycle: string;
      workState: string;
    }
  | { ok: false; error: string; status: number };

/**
 * Validates work item + draft for filing handoff (no DB writes).
 * Policy: draft must be `approved_for_candidate`, or `ready_for_review` with explicit operator ack in body (handled by caller passing `operator_ready_ack`).
 */
export async function assertWorkItemApprovedForFilingHandoff(args: {
  supabase: SupabaseClient;
  organizationId: string;
  storeId: string;
  workItemId: string;
  operatorReadyAck?: boolean;
}): Promise<WorkItemDraftGate> {
  const { supabase, organizationId, storeId, workItemId, operatorReadyAck } = args;
  if (!isUuidString(workItemId)) return { ok: false, error: "Invalid work item id.", status: 400 };

  const { data: wi, error } = await supabase
    .from("claim_review_work_items")
    .select("id, organization_id, store_id, draft_id, workflow_state")
    .eq("id", workItemId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message, status: 500 };
  if (!wi) return { ok: false, error: "Work item not found.", status: 404 };
  const row = wi as {
    id?: string;
    store_id?: string | null;
    draft_id?: string;
    workflow_state?: string;
  };
  if (String(row.store_id ?? "").trim() !== storeId) {
    return { ok: false, error: "Work item store does not match request.", status: 400 };
  }
  const draftId = String(row.draft_id ?? "").trim();
  if (!isUuidString(draftId)) return { ok: false, error: "Work item has no draft.", status: 400 };

  const wf = String(row.workflow_state ?? "");
  if (wf !== "completed") {
    return { ok: false, error: "Work item review must be completed before filing handoff.", status: 400 };
  }

  const { data: draft, error: dErr } = await supabase
    .from("claim_candidate_drafts")
    .select("id, lifecycle_status")
    .eq("id", draftId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (dErr) return { ok: false, error: dErr.message, status: 500 };
  if (!draft) return { ok: false, error: "Draft not found.", status: 404 };
  const life = String((draft as { lifecycle_status?: string }).lifecycle_status ?? "");
  if (life === "approved_for_candidate") {
    return { ok: true, workItemId, draftId, draftLifecycle: life, workState: wf };
  }
  if (life === "ready_for_review" && operatorReadyAck === true) {
    return { ok: true, workItemId, draftId, draftLifecycle: life, workState: wf };
  }
  return {
    ok: false,
    error:
      "Draft must be approved_for_candidate, or ready_for_review with operator_ready_ack:true for filing handoff.",
    status: 400,
  };
}

/** Draft-only anchor (no work item row): same lifecycle rules as {@link assertWorkItemApprovedForFilingHandoff}. */
export async function assertCandidateDraftApprovedForHandoff(args: {
  supabase: SupabaseClient;
  organizationId: string;
  storeId: string;
  draftId: string;
  operatorReadyAck?: boolean;
}): Promise<WorkItemDraftGate> {
  const { supabase, organizationId, storeId, draftId, operatorReadyAck } = args;
  if (!isUuidString(draftId)) return { ok: false, error: "Invalid draft id.", status: 400 };

  const { data: draft, error: dErr } = await supabase
    .from("claim_candidate_drafts")
    .select("id, organization_id, store_id, lifecycle_status")
    .eq("id", draftId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (dErr) return { ok: false, error: dErr.message, status: 500 };
  if (!draft) return { ok: false, error: "Draft not found.", status: 404 };
  const row = draft as { store_id?: string | null; lifecycle_status?: string };
  if (String(row.store_id ?? "").trim() !== storeId) {
    return { ok: false, error: "Draft store does not match request.", status: 400 };
  }
  const life = String(row.lifecycle_status ?? "");
  if (life === "approved_for_candidate") {
    return { ok: true, workItemId: null, draftId, draftLifecycle: life, workState: "n/a" };
  }
  if (life === "ready_for_review" && operatorReadyAck === true) {
    return { ok: true, workItemId: null, draftId, draftLifecycle: life, workState: "n/a" };
  }
  return {
    ok: false,
    error:
      "Draft must be approved_for_candidate, or ready_for_review with operator_ready_ack:true for filing handoff.",
    status: 400,
  };
}

export async function insertFilingRequestEvent(
  supabase: SupabaseClient,
  args: {
    filingRequestId: string;
    organizationId: string;
    eventType: "created" | "approved" | "callback_received" | "status_updated" | "cancelled";
    actorUserId: string | null;
    source: "app" | "agent" | "callback" | "system";
    payload: Record<string, unknown>;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.from("claim_filing_request_events").insert({
    filing_request_id: args.filingRequestId,
    organization_id: args.organizationId,
    event_type: args.eventType,
    actor_user_id: args.actorUserId,
    source: args.source,
    payload: args.payload,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
