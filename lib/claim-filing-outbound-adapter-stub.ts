/**
 * NEXT-CLAIM-FILING-AGENT-06 — Disabled-by-default outbound adapter stub.
 * When enabled via env, runs local validation only. Never calls Amazon, external APIs, or workers.
 */

import type { ClaimFilingOutboundPayloadV1 } from "./claim-filing-outbound-types";
import { validateClaimFilingOutboundPayloadV1 } from "./claim-filing-outbound-validator";

/**
 * When true, `runClaimFilingOutboundAdapterDryRun` validates payloads and returns structured dry-run logs.
 * Still does not perform HTTP, Amazon, or marketplace submission.
 */
export function isClaimFilingOutboundAdapterDryRunEnabled(): boolean {
  const v = process.env.ENABLE_CLAIM_FILING_OUTBOUND_ADAPTER_DRY_RUN?.trim().toLowerCase();
  return v === "true" || v === "1";
}

export type ClaimFilingOutboundAdapterDryRunResult =
  | { readonly ok: false; readonly disabled: true; readonly reason: string }
  | {
      readonly ok: false;
      readonly disabled: false;
      readonly errors: readonly string[];
      readonly dryRunLog: readonly string[];
    }
  | {
      readonly ok: true;
      readonly disabled: false;
      readonly payload: ClaimFilingOutboundPayloadV1;
      readonly dryRunLog: readonly string[];
    };

/**
 * Local dry-run only. Disabled unless `ENABLE_CLAIM_FILING_OUTBOUND_ADAPTER_DRY_RUN` is set.
 * No outbound HTTP, no Amazon, no worker orchestration.
 */
export function runClaimFilingOutboundAdapterDryRun(input: unknown): ClaimFilingOutboundAdapterDryRunResult {
  if (!isClaimFilingOutboundAdapterDryRunEnabled()) {
    return {
      ok: false,
      disabled: true,
      reason:
        "Outbound adapter dry-run is disabled. Set ENABLE_CLAIM_FILING_OUTBOUND_ADAPTER_DRY_RUN=true to validate payloads locally (still no Amazon or external HTTP).",
    };
  }

  const dryRunLog: string[] = [
    "dry_run_started",
    "amazon_calls: none",
    "external_http: none",
    "ai_calls: none",
    "worker_run: none",
  ];

  const validated = validateClaimFilingOutboundPayloadV1(input);
  if (!validated.ok) {
    dryRunLog.push(`validation_failed: ${validated.errors.join("; ")}`);
    return { ok: false, disabled: false, errors: validated.errors, dryRunLog };
  }

  dryRunLog.push("validation_ok");
  dryRunLog.push("marketplace_submission: blocked_by_contract");
  return { ok: true, disabled: false, payload: validated.payload, dryRunLog };
}
