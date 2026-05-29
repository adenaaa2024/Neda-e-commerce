/**
 * Environment guard for scanner → claim auto-promote (staging-first, production default off).
 *
 * Master: CLAIM_SCANNER_AUTO_PROMOTE_ENABLED (default off)
 * Original override: CLAIM_SCANNER_AUTO_PROMOTE_ORIGINAL_APPROVED (default off)
 */
import "server-only";

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

/** Guard skip reasons that are expected — do not warn in operator save path. */
export function isExpectedScannerClaimPromoteSkipReason(reason: string | undefined): boolean {
  if (!reason) return false;
  if (reason === "not_claimable") return true;
  if (reason.startsWith("invalid_")) return true;
  return (
    reason === "promote_disabled" ||
    reason === "original_ref_blocked" ||
    reason === "ref_not_allowed"
  );
}
