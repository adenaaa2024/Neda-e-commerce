/**
 * PHASE-CLAIM-AMOUNT-BASIS-POLICY-OPERATOR-CONFIRMATION-V1 — governed policy storage.
 *
 * Stores the operator-confirmed per-family claim-amount basis in the canonical
 * workspace_settings row under `module_configs.claims.amount_basis_policy`.
 * Read path is dependency-light (no node:fs); the write path is gated by an
 * operator approval file. NEVER mutates claim_* tables or calls Amazon.
 */
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  AmountBasis,
  AmountBasisPolicyOverlay,
  ConfirmedFamilyAmountPolicy,
} from "@/lib/claims/filing/claim-ready-to-file-queue-ui-contract";

export const CLAIM_AMOUNT_BASIS_POLICY_VERSION = "claim-amount-basis-policy-v1";
export const CLAIM_AMOUNT_BASIS_POLICY_APPROVAL_KEY = "APPROVED_CLAIM_AMOUNT_BASIS_POLICY_V1";
export const CLAIM_AMOUNT_BASIS_POLICY_APPROVAL_PATH =
  ".cursor/operator-approvals/claim-amount-basis-policy-v1-approval.md";

/** Where the confirmed policy lives inside the canonical workspace_settings row. */
export const CLAIM_AMOUNT_BASIS_POLICY_STORAGE_LOCATION =
  "workspace_settings.module_configs.claims.amount_basis_policy";

function metaRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

type CanonicalRow = { id: string; module_configs: Record<string, unknown>; source: "org_scoped" | "singleton" };

async function resolveCanonicalRow(client: SupabaseClient, organizationId: string): Promise<CanonicalRow | null> {
  const byOrg = await client
    .from("workspace_settings")
    .select("id, module_configs")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!byOrg.error && byOrg.data) {
    return {
      id: String((byOrg.data as { id: unknown }).id),
      module_configs: metaRecord((byOrg.data as { module_configs?: unknown }).module_configs),
      source: "org_scoped",
    };
  }
  const singleton = await client
    .from("workspace_settings")
    .select("id, module_configs")
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!singleton.error && singleton.data) {
    return {
      id: String((singleton.data as { id: unknown }).id),
      module_configs: metaRecord((singleton.data as { module_configs?: unknown }).module_configs),
      source: "singleton",
    };
  }
  return null;
}

function coerceOverlay(raw: unknown): AmountBasisPolicyOverlay | null {
  const obj = metaRecord(raw);
  const familiesRaw = metaRecord(obj.families);
  const familyKeys = Object.keys(familiesRaw);
  if (familyKeys.length === 0) return null;
  const families: Record<string, ConfirmedFamilyAmountPolicy> = {};
  for (const key of familyKeys) {
    const f = metaRecord(familiesRaw[key]);
    families[key] = {
      family_key: String(f.family_key ?? key),
      basis: String(f.basis ?? "cogs_recovery") as AmountBasis,
      use_as_seller_central_amount: f.use_as_seller_central_amount !== false,
      informational_only: Array.isArray(f.informational_only) ? f.informational_only.map(String) : [],
      confirmed_by: String(f.confirmed_by ?? "operator"),
      confirmed_at: String(f.confirmed_at ?? ""),
      approval_key: String(f.approval_key ?? CLAIM_AMOUNT_BASIS_POLICY_APPROVAL_KEY),
      note: f.note == null ? null : String(f.note),
    };
  }
  return {
    version: String(obj.version ?? CLAIM_AMOUNT_BASIS_POLICY_VERSION),
    confirmed_by: String(obj.confirmed_by ?? "operator"),
    confirmed_at: String(obj.confirmed_at ?? ""),
    approval_key: String(obj.approval_key ?? CLAIM_AMOUNT_BASIS_POLICY_APPROVAL_KEY),
    families,
  };
}

/** Read-only: load the confirmed amount-basis policy overlay (or null if none stored). */
export async function loadConfirmedAmountBasisPolicy(
  client: SupabaseClient,
  organizationId: string,
): Promise<AmountBasisPolicyOverlay | null> {
  const row = await resolveCanonicalRow(client, organizationId);
  if (!row) return null;
  const claims = metaRecord(row.module_configs.claims);
  return coerceOverlay(claims.amount_basis_policy);
}

/** Approval gate (write path only). */
export function readAmountBasisPolicyApproval(): { approved: boolean; block_reason: string | null } {
  const p = path.join(process.cwd(), CLAIM_AMOUNT_BASIS_POLICY_APPROVAL_PATH);
  if (!fs.existsSync(p)) {
    return { approved: false, block_reason: `${CLAIM_AMOUNT_BASIS_POLICY_APPROVAL_PATH} missing` };
  }
  const approved = new RegExp(`^${CLAIM_AMOUNT_BASIS_POLICY_APPROVAL_KEY}\\s*=\\s*yes\\s*$`, "im").test(
    fs.readFileSync(p, "utf8"),
  );
  return {
    approved,
    block_reason: approved ? null : `${CLAIM_AMOUNT_BASIS_POLICY_APPROVAL_KEY}=yes required in ${CLAIM_AMOUNT_BASIS_POLICY_APPROVAL_PATH}`,
  };
}

export type AmountBasisDecisionInput = {
  family_key: string;
  basis: AmountBasis;
  use_as_seller_central_amount: boolean;
  informational_only: string[];
  note?: string | null;
};

export type AmountBasisPolicyWriteResult = {
  ok: boolean;
  blocked: boolean;
  block_reason: string | null;
  written: boolean;
  storage_location: string;
  workspace_settings_row_id: string | null;
  workspace_settings_row_source: "org_scoped" | "singleton" | null;
  overlay_before: AmountBasisPolicyOverlay | null;
  overlay_after: AmountBasisPolicyOverlay | null;
  claim_counts_before: Record<string, number>;
  claim_counts_after: Record<string, number>;
};

async function claimCounts(client: SupabaseClient, organizationId: string): Promise<Record<string, number>> {
  const tables = ["claim_submissions", "claim_cases", "claim_lines", "claim_candidates", "claim_reference_edges"];
  const out: Record<string, number> = {};
  for (const t of tables) {
    const { count } = await client.from(t).select("id", { count: "exact", head: true }).eq("organization_id", organizationId);
    out[t] = count ?? -1;
  }
  return out;
}

/**
 * Governed write: persists the confirmed amount-basis policy overlay into the
 * canonical workspace_settings row (by id, verified on re-read). Blocked unless
 * the operator approval file has APPROVED_CLAIM_AMOUNT_BASIS_POLICY_V1=yes.
 */
export async function writeConfirmedAmountBasisPolicy(args: {
  client: SupabaseClient;
  organizationId: string;
  decisions: AmountBasisDecisionInput[];
  actorId: string;
}): Promise<AmountBasisPolicyWriteResult> {
  const storage = CLAIM_AMOUNT_BASIS_POLICY_STORAGE_LOCATION;
  const approval = readAmountBasisPolicyApproval();
  const claim_counts_before = await claimCounts(args.client, args.organizationId);
  const overlay_before = await loadConfirmedAmountBasisPolicy(args.client, args.organizationId);

  if (!approval.approved) {
    return {
      ok: false,
      blocked: true,
      block_reason: approval.block_reason,
      written: false,
      storage_location: storage,
      workspace_settings_row_id: null,
      workspace_settings_row_source: null,
      overlay_before,
      overlay_after: null,
      claim_counts_before,
      claim_counts_after: claim_counts_before,
    };
  }

  const confirmedAt = new Date().toISOString();
  const families: Record<string, ConfirmedFamilyAmountPolicy> = {};
  for (const d of args.decisions) {
    families[d.family_key] = {
      family_key: d.family_key,
      basis: d.basis,
      use_as_seller_central_amount: d.use_as_seller_central_amount,
      informational_only: d.informational_only,
      confirmed_by: args.actorId,
      confirmed_at: confirmedAt,
      approval_key: CLAIM_AMOUNT_BASIS_POLICY_APPROVAL_KEY,
      note: d.note ?? null,
    };
  }
  const overlay: AmountBasisPolicyOverlay = {
    version: CLAIM_AMOUNT_BASIS_POLICY_VERSION,
    confirmed_by: args.actorId,
    confirmed_at: confirmedAt,
    approval_key: CLAIM_AMOUNT_BASIS_POLICY_APPROVAL_KEY,
    families,
  };

  const row = await resolveCanonicalRow(args.client, args.organizationId);
  const moduleConfigs = metaRecord(row?.module_configs);
  const claims = metaRecord(moduleConfigs.claims);
  const nextModuleConfigs = {
    ...moduleConfigs,
    claims: { ...claims, amount_basis_policy: overlay },
  };

  let writeError: string | null = null;
  let rowsAffected = 0;
  let targetRowId = row?.id ?? null;
  let targetSource = row?.source ?? null;
  if (row?.id) {
    const { data, error } = await args.client
      .from("workspace_settings")
      .update({ module_configs: nextModuleConfigs })
      .eq("id", row.id)
      .select("id");
    writeError = error?.message ?? null;
    rowsAffected = data?.length ?? 0;
  } else {
    const { data, error } = await args.client
      .from("workspace_settings")
      .insert({ organization_id: args.organizationId, core_settings: {}, module_configs: nextModuleConfigs })
      .select("id");
    writeError = error?.message ?? null;
    rowsAffected = data?.length ?? 0;
    targetRowId = data && data.length > 0 ? String((data[0] as { id: unknown }).id) : null;
    targetSource = "org_scoped";
  }

  const claim_counts_after = await claimCounts(args.client, args.organizationId);

  if (writeError || rowsAffected === 0) {
    return {
      ok: false,
      blocked: false,
      block_reason: writeError ?? "workspace_settings write affected 0 rows (no canonical row resolved).",
      written: false,
      storage_location: storage,
      workspace_settings_row_id: targetRowId,
      workspace_settings_row_source: targetSource,
      overlay_before,
      overlay_after: null,
      claim_counts_before,
      claim_counts_after,
    };
  }

  const overlay_after = await loadConfirmedAmountBasisPolicy(args.client, args.organizationId);
  const persisted = overlay_after != null && args.decisions.every((d) => d.family_key in (overlay_after.families ?? {}));

  return {
    ok: persisted,
    blocked: false,
    block_reason: persisted ? null : "Persistence verification failed: confirmed families missing on re-read.",
    written: persisted,
    storage_location: storage,
    workspace_settings_row_id: targetRowId,
    workspace_settings_row_source: targetSource,
    overlay_before,
    overlay_after,
    claim_counts_before,
    claim_counts_after,
  };
}
