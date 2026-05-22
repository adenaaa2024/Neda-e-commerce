/**
 * NEXT-CLAIM-FILING-AGENT-06 — Validates claim-filing-outbound-v1 payloads locally.
 * No Amazon, no external HTTP, no DB writes.
 */

import type { FinancialReferenceCandidate, TridFilingPayloadExtension, TridSelectionStatus } from "./claim-trid-candidates-types";
import {
  CLAIM_FILING_OUTBOUND_SCHEMA_VERSION,
  type ClaimFilingOutboundAutomationMode,
  type ClaimFilingOutboundPayloadV1,
} from "./claim-filing-outbound-types";
import { isUuidString } from "./uuid";

const TRID_SELECTION: ReadonlySet<TridSelectionStatus> = new Set([
  "none",
  "pending_operator",
  "operator_selected",
  "skipped_no_reference",
]);

const AUTOMATION_ALLOWED: ReadonlySet<ClaimFilingOutboundAutomationMode> = new Set([
  "disabled",
  "manual_only",
  "prepare_only",
  "submit_with_confirmation",
  "full_auto_reserved",
]);

const FORBIDDEN_KEY_RE = /password|secret|service_role|authorization|cookie|mfa|bearer\s/i;

function candidateKey(c: FinancialReferenceCandidate): string {
  return `${c.trid_key}\0${String(c.source_table ?? "")}\0${String(c.source_row_id ?? "")}`;
}

function selectedMatchesCandidate(selected: FinancialReferenceCandidate, c: FinancialReferenceCandidate): boolean {
  return candidateKey(selected) === candidateKey(c);
}

function walkForForbiddenKeys(value: unknown, path: string): string | null {
  if (value == null) return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = walkForForbiddenKeys(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as unknown as Record<string, unknown>)) {
      if (FORBIDDEN_KEY_RE.test(k)) {
        return `Forbidden key near ${path}.${k}`;
      }
      const hit = walkForForbiddenKeys(v, `${path}.${k}`);
      if (hit) return hit;
    }
  }
  return null;
}

export type ValidateClaimFilingOutboundOptions = {
  /** When true, `lease_context` must be present (future Agent 04). Default from env `ENABLE_CLAIM_FILING_OUTBOUND_REQUIRE_LEASE`. */
  readonly requireLeaseContext?: boolean;
};

export function isClaimFilingOutboundLeaseContextRequired(): boolean {
  const v = process.env.ENABLE_CLAIM_FILING_OUTBOUND_REQUIRE_LEASE?.trim().toLowerCase();
  return v === "true" || v === "1";
}

export function validateClaimFilingOutboundPayloadV1(
  input: unknown,
  options?: ValidateClaimFilingOutboundOptions,
): { ok: true; payload: ClaimFilingOutboundPayloadV1 } | { ok: false; errors: readonly string[] } {
  const errors: string[] = [];
  const requireLease = options?.requireLeaseContext ?? isClaimFilingOutboundLeaseContextRequired();

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["Root payload must be an object."] };
  }
  const o = input as unknown as Record<string, unknown>;

  const keyHit = walkForForbiddenKeys(o, "$");
  if (keyHit) errors.push(keyHit);

  if (o.schema_version !== CLAIM_FILING_OUTBOUND_SCHEMA_VERSION) {
    errors.push(`schema_version must be "${CLAIM_FILING_OUTBOUND_SCHEMA_VERSION}".`);
  }

  const filingRequestId = typeof o.filing_request_id === "string" ? o.filing_request_id.trim() : "";
  if (!isUuidString(filingRequestId)) errors.push("filing_request_id must be a UUID.");

  const organizationId = typeof o.organization_id === "string" ? o.organization_id.trim() : "";
  if (!isUuidString(organizationId)) errors.push("organization_id must be a UUID.");

  const storeId = typeof o.store_id === "string" ? o.store_id.trim() : "";
  if (!isUuidString(storeId)) errors.push("store_id must be a UUID.");

  const environment = o.environment;
  if (environment !== "sandbox" && environment !== "production") {
    errors.push("environment must be sandbox or production.");
  }

  const automationMode = o.automation_mode;
  if (typeof automationMode !== "string" || !AUTOMATION_ALLOWED.has(automationMode as ClaimFilingOutboundAutomationMode)) {
    errors.push("automation_mode must be a known filing automation mode.");
  } else if (automationMode === "full_auto_reserved") {
    errors.push("automation_mode full_auto_reserved is not allowed on outbound payloads.");
  }

  const leaseRaw = o.lease_context;
  if (leaseRaw == null) {
    if (requireLease) errors.push("lease_context is required when ENABLE_CLAIM_FILING_OUTBOUND_REQUIRE_LEASE is true.");
  } else if (typeof leaseRaw !== "object" || Array.isArray(leaseRaw)) {
    errors.push("lease_context must be an object or null.");
  } else {
    const lc = leaseRaw as unknown as Record<string, unknown>;
    const holder = typeof lc.lease_holder === "string" ? lc.lease_holder.trim() : "";
    const exp = typeof lc.lease_expires_at === "string" ? lc.lease_expires_at.trim() : "";
    if (!holder) errors.push("lease_context.lease_holder is required when lease_context is set.");
    if (!exp) errors.push("lease_context.lease_expires_at is required when lease_context is set.");
    if (exp && Number.isNaN(Date.parse(exp))) errors.push("lease_context.lease_expires_at must be ISO-8601 parseable.");
  }

  const idem = o.idempotency;
  if (!idem || typeof idem !== "object" || Array.isArray(idem)) {
    errors.push("idempotency must be an object.");
  } else {
    const id = idem as unknown as Record<string, unknown>;
    const frk = typeof id.filing_request_idempotency_key === "string" ? id.filing_request_idempotency_key.trim() : "";
    if (!frk) errors.push("idempotency.filing_request_idempotency_key is required.");
    const odid = typeof id.outbound_delivery_id === "string" ? id.outbound_delivery_id.trim() : "";
    if (!isUuidString(odid)) errors.push("idempotency.outbound_delivery_id must be a UUID.");
    const ccid = typeof id.callback_correlation_id === "string" ? id.callback_correlation_id.trim() : "";
    if (!isUuidString(ccid)) errors.push("idempotency.callback_correlation_id must be a UUID.");
    const ph = typeof id.payload_hash === "string" ? id.payload_hash.trim() : "";
    if (!ph.startsWith("sha256:") || ph.length < 16) {
      errors.push("idempotency.payload_hash must be a sha256: prefixed hash string.");
    }
  }

  const claim = o.claim_context;
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
    errors.push("claim_context must be an object.");
  } else {
    const c = claim as unknown as Record<string, unknown>;
    const wi = c.claim_review_work_item_id;
    const dr = c.claim_candidate_draft_id;
    const sub = c.claim_submission_id;
    const wiOk = wi == null || (typeof wi === "string" && isUuidString(wi.trim()));
    const drOk = dr == null || (typeof dr === "string" && isUuidString(dr.trim()));
    const subOk = sub == null || (typeof sub === "string" && isUuidString(sub.trim()));
    if (!wiOk) errors.push("claim_context.claim_review_work_item_id must be null or a UUID.");
    if (!drOk) errors.push("claim_context.claim_candidate_draft_id must be null or a UUID.");
    if (!subOk) errors.push("claim_context.claim_submission_id must be null or a UUID.");
    const st = typeof c.source_table === "string" ? c.source_table.trim() : "";
    const sr = typeof c.source_row_id === "string" ? c.source_row_id.trim() : "";
    if (!st) errors.push("claim_context.source_table is required.");
    if (!sr) errors.push("claim_context.source_row_id is required.");
    const anchors =
      (typeof wi === "string" && isUuidString(wi.trim()) ? 1 : 0) +
      (typeof dr === "string" && isUuidString(dr.trim()) ? 1 : 0) +
      (typeof sub === "string" && isUuidString(sub.trim()) ? 1 : 0);
    if (anchors === 0) {
      errors.push("claim_context must set at least one of claim_review_work_item_id, claim_candidate_draft_id, claim_submission_id.");
    }
  }

  const fi = o.filing_instructions;
  if (!fi || typeof fi !== "object" || Array.isArray(fi)) {
    errors.push("filing_instructions must be an object.");
  } else {
    const f = fi as unknown as Record<string, unknown>;
    if (f.marketplace_submission_allowed === true) {
      errors.push("filing_instructions.marketplace_submission_allowed must be false for Agent 06 payloads.");
    }
    if (f.requires_operator_confirmation_before_submit !== true) {
      errors.push("filing_instructions.requires_operator_confirmation_before_submit must be true for outbound v1.");
    }
    const aa = f.allowed_actions;
    if (!Array.isArray(aa) || aa.length === 0) {
      errors.push("filing_instructions.allowed_actions must be a non-empty array.");
    }
  }

  const ev = o.evidence_package;
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) {
    errors.push("evidence_package must be an object.");
  } else {
    const e = ev as unknown as Record<string, unknown>;
    if (!Array.isArray(e.pdf_refs)) errors.push("evidence_package.pdf_refs must be an array.");
    if (!Array.isArray(e.artifact_refs)) errors.push("evidence_package.artifact_refs must be an array.");
    const m = e.manifest;
    if (!m || typeof m !== "object" || Array.isArray(m)) {
      errors.push("evidence_package.manifest must be an object.");
    } else {
      const man = m as unknown as Record<string, unknown>;
      const eh = typeof man.evidence_hash === "string" ? man.evidence_hash.trim() : "";
      if (!eh.startsWith("sha256:")) errors.push("evidence_package.manifest.evidence_hash must start with sha256:.");
      const ga = typeof man.generated_at === "string" ? man.generated_at.trim() : "";
      if (!ga || Number.isNaN(Date.parse(ga))) errors.push("evidence_package.manifest.generated_at must be ISO-8601 parseable.");
      const rp = typeof man.redaction_profile === "string" ? man.redaction_profile.trim() : "";
      if (!rp) errors.push("evidence_package.manifest.redaction_profile is required.");
    }
  }

  const payload = o.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    errors.push("payload must be an object.");
  } else {
    const p = payload as unknown as Record<string, unknown>;
    const trid = p.trid;
    if (trid != null && (typeof trid !== "object" || Array.isArray(trid))) {
      errors.push("payload.trid must be an object or null.");
    } else if (trid && typeof trid === "object" && !Array.isArray(trid)) {
      const t = trid as unknown as Record<string, unknown>;
      const status = t.trid_selection_status;
      if (status != null && (typeof status !== "string" || !TRID_SELECTION.has(status as TridSelectionStatus))) {
        errors.push("payload.trid.trid_selection_status must be a valid TridSelectionStatus.");
      }
      const candidates = t.trid_candidates;
      const list: FinancialReferenceCandidate[] = Array.isArray(candidates)
        ? (candidates.filter((x) => x && typeof x === "object" && !Array.isArray(x)) as FinancialReferenceCandidate[])
        : [];
      const selected = t.trid_operator_selected;
      const selObj =
        selected && typeof selected === "object" && !Array.isArray(selected) ? (selected as FinancialReferenceCandidate) : null;

      if (status === "operator_selected") {
        if (!selObj || !selObj.trid_key) {
          errors.push("payload.trid.trid_operator_selected is required when trid_selection_status is operator_selected.");
        } else if (list.length === 0) {
          errors.push("payload.trid.trid_candidates must be non-empty when trid_selection_status is operator_selected.");
        } else if (!list.some((c) => selectedMatchesCandidate(selObj, c))) {
          errors.push("payload.trid.trid_operator_selected must match an entry in trid_candidates.");
        }
        const by = t.trid_selected_by;
        if (typeof by !== "string" || !isUuidString(by.trim())) {
          errors.push("payload.trid.trid_selected_by must be a UUID when trid_selection_status is operator_selected.");
        }
        const at = t.trid_selected_at;
        if (typeof at !== "string" || !at.trim() || Number.isNaN(Date.parse(at.trim()))) {
          errors.push("payload.trid.trid_selected_at must be ISO-8601 parseable when trid_selection_status is operator_selected.");
        }
      }
      if (status === "skipped_no_reference" && list.length > 0) {
        errors.push("payload.trid.trid_candidates should be empty when trid_selection_status is skipped_no_reference.");
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, payload: input as ClaimFilingOutboundPayloadV1 };
}
