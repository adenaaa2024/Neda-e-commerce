/**
 * NEXT-CLAIM-FILING-AGENT-06 — Verify outbound payload validator + fixtures (no network).
 * Run: npx tsx scripts/verify-claim-filing-outbound-payload.ts
 */

import {
  runClaimFilingOutboundAdapterDryRun,
  isClaimFilingOutboundAdapterDryRunEnabled,
} from "../lib/claim-filing-outbound-adapter-stub";
import {
  OUTBOUND_FIXTURE_AMBIGUOUS_TRID,
  OUTBOUND_FIXTURE_DETERMINISTIC_TRID,
  OUTBOUND_FIXTURE_INVALID_OPERATOR_SELECTED,
  OUTBOUND_FIXTURE_INVALID_SCHEMA,
  OUTBOUND_FIXTURE_INVALID_SUBMISSION_FLAG,
  OUTBOUND_FIXTURE_MISSING_TRID_SKIPPED,
} from "../lib/claim-filing-outbound-fixtures";
import { validateClaimFilingOutboundPayloadV1 } from "../lib/claim-filing-outbound-validator";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function main(): void {
  const origDry = process.env.ENABLE_CLAIM_FILING_OUTBOUND_ADAPTER_DRY_RUN;
  delete process.env.ENABLE_CLAIM_FILING_OUTBOUND_ADAPTER_DRY_RUN;

  const v1 = validateClaimFilingOutboundPayloadV1(OUTBOUND_FIXTURE_DETERMINISTIC_TRID);
  assert(v1.ok, "deterministic fixture should validate");

  const v2 = validateClaimFilingOutboundPayloadV1(OUTBOUND_FIXTURE_AMBIGUOUS_TRID);
  assert(v2.ok, "ambiguous fixture should validate");

  const v3 = validateClaimFilingOutboundPayloadV1(OUTBOUND_FIXTURE_MISSING_TRID_SKIPPED);
  assert(v3.ok, "missing/skipped fixture should validate");

  const bad1 = validateClaimFilingOutboundPayloadV1(OUTBOUND_FIXTURE_INVALID_OPERATOR_SELECTED);
  assert(!bad1.ok, "invalid operator_selected should fail");

  const bad2 = validateClaimFilingOutboundPayloadV1(OUTBOUND_FIXTURE_INVALID_SCHEMA);
  assert(!bad2.ok, "invalid schema should fail");

  const bad3 = validateClaimFilingOutboundPayloadV1(OUTBOUND_FIXTURE_INVALID_SUBMISSION_FLAG);
  assert(!bad3.ok, "marketplace_submission_allowed true should fail");

  const badConfirm = {
    ...OUTBOUND_FIXTURE_DETERMINISTIC_TRID,
    filing_instructions: {
      ...OUTBOUND_FIXTURE_DETERMINISTIC_TRID.filing_instructions,
      requires_operator_confirmation_before_submit: false,
    },
  };
  const bad4 = validateClaimFilingOutboundPayloadV1(badConfirm);
  assert(!bad4.ok, "requires_operator_confirmation_before_submit false should fail");

  const badLease = validateClaimFilingOutboundPayloadV1(OUTBOUND_FIXTURE_DETERMINISTIC_TRID, { requireLeaseContext: true });
  assert(!badLease.ok, "requireLeaseContext without lease should fail");

  assert(!isClaimFilingOutboundAdapterDryRunEnabled(), "dry run must be off by default in this script environment");
  const stubOff = runClaimFilingOutboundAdapterDryRun(OUTBOUND_FIXTURE_DETERMINISTIC_TRID);
  assert(!stubOff.ok && stubOff.disabled, "stub must be disabled without env");

  process.env.ENABLE_CLAIM_FILING_OUTBOUND_ADAPTER_DRY_RUN = "true";
  const stubOn = runClaimFilingOutboundAdapterDryRun(OUTBOUND_FIXTURE_DETERMINISTIC_TRID);
  if (!stubOn.ok || stubOn.disabled) throw new Error("stub should validate when dry run enabled");
  assert(stubOn.dryRunLog.includes("amazon_calls: none"), "dry run log should assert no Amazon");

  if (origDry === undefined) delete process.env.ENABLE_CLAIM_FILING_OUTBOUND_ADAPTER_DRY_RUN;
  else process.env.ENABLE_CLAIM_FILING_OUTBOUND_ADAPTER_DRY_RUN = origDry;

  // eslint-disable-next-line no-console
  console.log("verify-claim-filing-outbound-payload: OK");
}

main();
