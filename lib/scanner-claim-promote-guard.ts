/**
 * Environment guard for scanner → claim auto-promote (staging-first, production default off).
 *
 * Master: CLAIM_SCANNER_AUTO_PROMOTE_ENABLED (default off)
 * Original override: CLAIM_SCANNER_AUTO_PROMOTE_ORIGINAL_APPROVED (default off)
 */
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getEffectiveClaimSettings } from "./claim-effective-settings";
import { loadGlobalClaimAgentConfig } from "./claim-filing-handoff";
import { refFromSupabaseUrl } from "./staging-project-ref";

export const SCANNER_CLAIM_STAGING_REF = "eiqfaapyumhixxoeltgu";
export const SCANNER_CLAIM_ORIGINAL_REF = "kxsvedvpjldygtdbylsy";

export type ScannerClaimPromoteGuardResult = {
  allowed: boolean;
  skipped_reason?: string;
  ref: string | null;
};

function envTruthy(name: string): boolean {
  const v = (process.env[name] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function scannerClaimAutoPromoteEnabled(): boolean {
  return envTruthy("CLAIM_SCANNER_AUTO_PROMOTE_ENABLED");
}

export function scannerClaimAutoPromoteOriginalApproved(): boolean {
  return envTruthy("CLAIM_SCANNER_AUTO_PROMOTE_ORIGINAL_APPROVED");
}

/** Active Supabase project ref from Next.js runtime quartet. */
export function supabaseProjectRefFromRuntimeEnv(): string | null {
  const url =
    (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim() ||
    (process.env.SUPABASE_URL ?? "").trim();
  return refFromSupabaseUrl(url);
}

/**
 * Decide whether scanner → claim promotion may run. No side effects.
 * Default: off everywhere; staging allowed only when master switch is on.
 */
export function evaluateScannerClaimPromoteGuard(): ScannerClaimPromoteGuardResult {
  const ref = supabaseProjectRefFromRuntimeEnv();

  if (!scannerClaimAutoPromoteEnabled()) {
    return { allowed: false, skipped_reason: "promote_disabled", ref };
  }

  if (ref === SCANNER_CLAIM_STAGING_REF) {
    return { allowed: true, ref };
  }

  if (ref === SCANNER_CLAIM_ORIGINAL_REF) {
    if (scannerClaimAutoPromoteOriginalApproved()) {
      return { allowed: true, ref };
    }
    return { allowed: false, skipped_reason: "original_ref_blocked", ref };
  }

  return {
    allowed: false,
    skipped_reason: ref ? "ref_not_allowed" : "ref_not_allowed",
    ref,
  };
}

function refAllowsScannerPromote(ref: string | null): boolean {
  if (ref === SCANNER_CLAIM_STAGING_REF) return true;
  if (ref === SCANNER_CLAIM_ORIGINAL_REF && scannerClaimAutoPromoteOriginalApproved()) return true;
  return false;
}

/**
 * Env master switch OR workspace `scanner_auto_promote_on_save` (default on) on allowed refs.
 */
export async function evaluateScannerClaimPromoteAllowed(
  client: SupabaseClient,
): Promise<ScannerClaimPromoteGuardResult> {
  const envGuard = evaluateScannerClaimPromoteGuard();
  if (envGuard.allowed) return envGuard;

  const ref = envGuard.ref ?? supabaseProjectRefFromRuntimeEnv();
  if (!refAllowsScannerPromote(ref)) {
    return { allowed: false, skipped_reason: envGuard.skipped_reason ?? "ref_not_allowed", ref };
  }

  const agent = await loadGlobalClaimAgentConfig(client);
  if (agent.scanner_auto_promote_on_save === false) {
    return { allowed: false, skipped_reason: "promote_disabled_settings", ref };
  }

  return { allowed: true, ref };
}

/** Org-scoped promote gate (settings resolver + env). */
export async function evaluateScannerClaimPromoteAllowedForOrg(
  client: SupabaseClient,
  organizationId: string,
  storeId?: string | null,
): Promise<ScannerClaimPromoteGuardResult> {
  const envGuard = evaluateScannerClaimPromoteGuard();
  if (envGuard.allowed) return envGuard;

  const ref = envGuard.ref ?? supabaseProjectRefFromRuntimeEnv();
  if (!refAllowsScannerPromote(ref)) {
    return { allowed: false, skipped_reason: envGuard.skipped_reason ?? "ref_not_allowed", ref };
  }

  const settings = await getEffectiveClaimSettings(client, organizationId, storeId);
  if (!settings.auto_create_drafts_on_scan) {
    return { allowed: false, skipped_reason: "promote_disabled_settings", ref };
  }

  return { allowed: true, ref };
}

/** Guard skip reasons that are expected — do not warn in operator save path. */
export function isExpectedScannerClaimPromoteSkipReason(reason: string | undefined): boolean {
  if (!reason) return false;
  if (reason === "not_claimable") return true;
  if (reason.startsWith("invalid_")) return true;
  return (
    reason === "promote_disabled" ||
    reason === "original_ref_blocked" ||
    reason === "ref_not_allowed" ||
    reason === "scan_not_live" ||
    reason === "import_pre_cutoff" ||
    reason === "outside_window" ||
    reason === "hold_package_open" ||
    reason === "hold_pallet_open" ||
    reason === "hold_order_incomplete" ||
    reason === "manual_review_required" ||
    reason === "missing_scanner_evidence" ||
    reason === "missing_operator_note" ||
    reason === "needs_product_resolution" ||
    reason === "promote_disabled_settings" ||
    reason === "create_case_manual_only" ||
    reason === "create_case_awaiting_package_closed" ||
    reason === "create_case_awaiting_pallet_closed" ||
    reason === "create_case_awaiting_removal_order_closed"
  );
}
