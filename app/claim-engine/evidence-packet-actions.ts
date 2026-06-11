"use server";

/**
 * Phase 7G — evidence packet composition actions.
 * Read-only over the claim pool: composes packets, never promotes, never submits.
 */
import { assertUserCanAccessOrganization } from "../dashboard/products/pim-actions";
import { composeClaimEvidencePacket } from "../../lib/claims/evidence/claim-evidence-packet-composer";
import { renderClaimEvidencePacketHtml } from "../../lib/claims/evidence/claim-evidence-packet-html";
import type { ClaimEvidencePacket } from "../../lib/claims/evidence/claim-evidence-packet-types";
import { supabaseServer } from "../../lib/supabase-server";
import { isUuidString } from "../../lib/uuid";

export type ComposeEvidencePacketActionResult =
  | { ok: true; packet: ClaimEvidencePacket; html: string }
  | { ok: false; error: string; blocked_reason?: string | null };

export async function composeClaimEvidencePacketAction(args: {
  organizationId: string;
  candidateIds: string[];
  title?: string | null;
  /** Operator confirmed mixed-grouping warnings (and override when policy allows). */
  confirmMixed?: boolean;
}): Promise<ComposeEvidencePacketActionResult> {
  const organizationId = String(args.organizationId ?? "").trim();
  if (!isUuidString(organizationId)) {
    return { ok: false, error: "organization_id must be a UUID." };
  }
  const gate = await assertUserCanAccessOrganization(organizationId);
  if (!gate.ok) {
    return { ok: false, error: gate.error };
  }
  const candidateIds = (args.candidateIds ?? []).filter((id) => isUuidString(String(id ?? "").trim()));
  if (!candidateIds.length) {
    return { ok: false, error: "At least one valid candidate id is required." };
  }

  const result = await composeClaimEvidencePacket(supabaseServer, {
    organizationId,
    candidateIds,
    title: args.title ?? null,
    confirmMixed: args.confirmMixed === true,
  });
  if (!result.ok) {
    return { ok: false, error: result.error, blocked_reason: result.blocked_reason ?? null };
  }
  return { ok: true, packet: result.packet, html: renderClaimEvidencePacketHtml(result.packet) };
}
