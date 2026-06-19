/**
 * PHASE-CLAIM-READY-TO-FILE-QUEUE-UI-V1
 *
 * Read-only operational queue read-model: classifies the 10 pilot claim packets
 * into Ready-to-File vs Blocked via a deterministic correctness audit, and shapes
 * a UI payload for the /claim-center/ready-to-file page (summary cards, table rows,
 * filters, detail drawer, Seller Central copy section, guarded Case ID recording).
 *
 * Composes existing read-models only — NO DB writes, NO claim_* mutation, NO Amazon,
 * NO browser automation, NO AI. Reuses:
 *  - composeClaimSellerCentralFilingPacketV1 (subjects/bodies/amounts/attachments/record-back)
 *  - composeMoneyLanePreviewAfterCogsV1 (sold price / fees / settlement / COGS / recovery)
 *  - composeTridReferenceTraceMatrixV1 (full reference edges + TRID anchor + event-date usage)
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "./claim-filing-packet-v1-plan-contract";
import { composeClaimSellerCentralFilingPacketV1 } from "./claim-seller-central-filing-packet-v1";
import { composeMoneyLanePreviewAfterCogsV1 } from "../submission/claim-money-lane-preview-after-cogs-v1";
import {
  composeTridReferenceTraceMatrixV1,
  EVENT_DATETIME_FILTER_USED,
} from "../reference/trid-reference-trace-matrix-v1";
import {
  composeClaimEventReferenceLedgerForTrace,
  EVENT_DATETIME_NOTE,
} from "../reference/claim-event-reference-ledger-v1";
import { loadConfirmedAmountBasisPolicy } from "../policy/claim-amount-basis-policy-v1";
import { loadClaimIntakeSettings } from "../intake/claim-intake-settings";
import { loadEffectiveClaimIntakePolicy } from "../intake/claim-intake-policy-contract";
import { loadRemovalOriginInputsForRows } from "./claim-removal-origin-basis-v1";
import {
  CLAIM_READY_TO_FILE_QUEUE_V1,
  READY_TO_FILE_ELIGIBLE_FAMILIES,
  type ClaimEventReferenceLedger,
  type ReadyToFileAuditItem,
  type ReadyToFileMoneyLane,
  type ReadyToFileQueuePayload,
  type ReadyToFileReferenceHealth,
  type ReadyToFileRow,
  type ReadyToFileSummaryCards,
} from "./claim-ready-to-file-queue-ui-contract";

// Re-export the client-safe contract surface so existing server/script imports keep working.
export {
  CLAIM_READY_TO_FILE_QUEUE_V1,
  READY_TO_FILE_ELIGIBLE_FAMILIES,
  DEFAULT_READY_TO_FILE_FILTERS,
  filterReadyToFileRows,
  buildReferenceBlockText,
} from "./claim-ready-to-file-queue-ui-contract";
export type {
  ReadyToFileAuditItem,
  ReadyToFileMoneyLane,
  ReadyToFileReferenceEdge,
  ReadyToFileReferenceHealth,
  ReadyToFileRow,
  ReadyToFileSummaryCards,
  ReadyToFileCaseIdRecordingConfig,
  ReadyToFileQueuePayload,
  ReadyToFileFilterState,
} from "./claim-ready-to-file-queue-ui-contract";

/** Source tables that indicate scanner-only / OCR-only origin (never ready-to-file alone). */
const SCANNER_OR_OCR_SOURCE_RE = /return_item|scanner|ocr|manual_scan/i;

/** Fake / synthetic scan-code patterns that must never reach Seller Central. */
const FAKE_SCAN_CODE_RE = /^(TEST|FAKE|DEMO|SAMPLE|SIM[-_]|DUMMY|XXXX)/i;

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function observedStatusLabel(value: number | null, status: string): string {
  if (value != null && value > 0) return `Observed ${value}`;
  return status === "pending" || status === "unknown" ? "Unknown/Pending" : "Unknown/Pending";
}

export async function composeClaimReadyToFileQueueV1(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  opts: { pilot_case_run_id?: string; intake_run_id?: string } = {},
): Promise<ReadyToFileQueuePayload> {
  const pilotCaseRunId = opts.pilot_case_run_id ?? PILOT_CASE_RUN_ID;
  const intakeRunId = opts.intake_run_id ?? PILOT_INTAKE_RUN_ID;
  const runOpts = { pilot_case_run_id: pilotCaseRunId, intake_run_id: intakeRunId };

  const [packets, money, trace, amountBasisPolicy, intake, effectivePolicy] = await Promise.all([
    composeClaimSellerCentralFilingPacketV1(client, organizationId, storeId, runOpts),
    composeMoneyLanePreviewAfterCogsV1(client, organizationId, storeId, runOpts),
    composeTridReferenceTraceMatrixV1(client, organizationId, storeId, runOpts),
    loadConfirmedAmountBasisPolicy(client, organizationId),
    loadClaimIntakeSettings(client, organizationId),
    loadEffectiveClaimIntakePolicy(client, organizationId, storeId),
  ]);

  const hasOrgIntakeOverride = intake.sources_read.some(
    (s) => s.startsWith("organization_settings.claim_policy.intake") && !s.includes("absent"),
  );
  const missingThresholdDays = intake.settings.delayed_not_received_days;
  const missingThresholdSource = hasOrgIntakeOverride
    ? "organization_settings.claim_policy.intake.delayed_not_received_days"
    : "workspace_settings.module_configs.claim_intake.delayed_not_received_days";

  // ---- Part A: read-only settings audit (no invented values) ----
  const scanStartValue = effectivePolicy.scan_go_live_date;
  type SettingsAudit = NonNullable<ReadyToFileQueuePayload["settings_audit"]>;
  const missingSettings: SettingsAudit["missing_settings"] = [];
  if (!scanStartValue) {
    missingSettings.push({
      key: "scan_go_live_date",
      meaning: "Date from which scanner/receipt data is considered reliable (scan/receipt availability start).",
      recommended_setting_key: "organization_settings.claim_policy.scan_go_live_date",
    });
  }
  if (!effectivePolicy.claim_start_date) {
    missingSettings.push({
      key: "claim_start_date",
      meaning: "Earliest event date eligible for import/API-sourced claims.",
      recommended_setting_key: "organization_settings.claim_policy.claim_start_date",
    });
  }
  const settingsAudit: SettingsAudit = {
    delayed_not_received_days: missingThresholdDays,
    delayed_not_received_days_source: missingThresholdSource,
    scan_availability_start_found: scanStartValue != null,
    scan_availability_start_value: scanStartValue,
    scan_availability_start_source: scanStartValue
      ? (hasOrgIntakeOverride
          ? "organization_settings.claim_policy.scan_go_live_date"
          : "organization_settings.claim_policy.scan_go_live_date (effective)")
      : "missing_setting",
    claim_start_date: effectivePolicy.claim_start_date,
    claim_eligibility_window_days: effectivePolicy.claim_eligibility_window_days,
    expiration_warning_days: effectivePolicy.expiration_warning_days,
    expected_package_matching_window_days: intake.settings.rolling_window_days ?? null,
    expected_package_matching_window_source: hasOrgIntakeOverride
      ? "organization_settings.claim_policy.intake.rolling_window_days"
      : "workspace_settings.module_configs.claim_intake.rolling_window_days (or default)",
    sources_read: effectivePolicy.sources_read,
    has_org_override: hasOrgIntakeOverride,
    missing_settings: missingSettings,
  };

  const moneyBySubmission = new Map(
    money.per_submission_money_matrix.map((r) => [r.claim_submission_id, r]),
  );
  const traceBySubmission = new Map(
    trace.per_submission_reference_matrix.map((r) => [r.claim_submission_id, r]),
  );

  // Resolve REAL external Amazon event/report references per submission (read-only).
  const { ledgers: ledgerBySubmission, census: deepReferenceCensus } =
    await composeClaimEventReferenceLedgerForTrace(
      client,
      organizationId,
      trace.per_submission_reference_matrix,
    );
  const emptyLedger = (subId: string, caseId: string | null, family: string | null): ClaimEventReferenceLedger => ({
    claim_submission_id: subId,
    claim_case_id: caseId,
    claim_family: family,
    product_identity: { resolved_product_id: null, fnsku: null, sku: null, asin: null },
    quantity: null,
    event_datetime: null,
    event_time_window_used: EVENT_DATETIME_FILTER_USED,
    event_datetime_note: EVENT_DATETIME_NOTE,
    primary_reference_anchor: {
      label: "Internal anchor (Expected Package ID)",
      value: null,
      kind: "expected_package_id",
      is_external_amazon_reference: false,
    },
    external_references: [],
    internal_anchors: [],
    removal_order_refs: [],
    removal_shipment_refs: [],
    tracking_refs: [],
    inventory_ledger_refs: [],
    transaction_refs: [],
    reimbursement_refs: [],
    external_reference_count: 0,
    internal_anchor_count: 0,
    match_reasons: [],
    confidence: "low",
    ambiguity_flag: false,
    missing_reference: true,
    needs_reference_review: true,
    seller_central_reference_block: "NEEDS REFERENCE REVIEW — no external Amazon reference resolved.",
    source_groups: [],
    customer_return_refs: [],
    report_metadata_refs: [],
    matched_by: [],
    date_window_used: EVENT_DATETIME_FILTER_USED,
    date_window_days: 45,
    date_window_candidate_count: 0,
    not_found_sources: [],
    ambiguous_sources: [],
    filing_sufficiency: "needs_reference_review",
  });

  const rows: ReadyToFileRow[] = [];

  for (const packet of packets.per_submission_filing_packet) {
    const subId = packet.claim_submission_id;
    const m = moneyBySubmission.get(subId) ?? null;
    const t = traceBySubmission.get(subId) ?? null;
    const ledger = ledgerBySubmission.get(subId) ?? emptyLedger(subId, packet.claim_case_id, packet.claim_family);

    const family = packet.claim_family;
    const recoveryValue = packet.requested_reimbursement_amount;
    const cogsUnit = packet.approved_cogs_unit;
    const quantity = packet.quantity_affected;
    const latestSoldPrice = m?.latest_sold_price ?? null;

    // ---- Correctness audit gates ----
    const familyEligible = family != null && (READY_TO_FILE_ELIGIBLE_FAMILIES as readonly string[]).includes(family);
    const sourceTable = t?.source_table ?? packet.source_table ?? null;
    const scannerOnly = sourceTable != null && SCANNER_OR_OCR_SOURCE_RE.test(sourceTable);
    const deterministicGraph = (t?.reference_edge_count ?? 0) > 0 && (t?.ambiguous_matches.length ?? 0) === 0;
    const hasCogs = cogsUnit != null;
    const hasRecovery = recoveryValue != null && recoveryValue > 0;
    const hasTridAnchor = Boolean(packet.trid || packet.expected_package_id || packet.product_link_resolved_product_id);
    const familyRefOk =
      family === "removal_shipment_missing"
        ? Boolean(packet.removal_shipment_id)
        : family === "removal_order_discrepancy"
          ? Boolean(packet.removal_order_id)
          : false;
    const hasEvidence = !packet.blockers.includes("missing_evidence_packet");

    const refValues = [
      ...(t?.removal_order_ids ?? []),
      ...(t?.removal_shipment_ids ?? []),
      ...(t?.tracking_numbers ?? []),
      str(packet.fnsku),
      str(packet.sku),
    ].filter(Boolean);
    const usesFakeScanCode = refValues.some((v) => FAKE_SCAN_CODE_RE.test(v));

    const usesSimulatedCaseId =
      packet.fields_to_record_back.amazon_case_id != null ||
      FAKE_SCAN_CODE_RE.test(str(packet.fields_to_record_back.amazon_case_id));

    // Claim amount must equal recovery_value (qty × COGS) — never the sale price.
    const usesSalePriceAsAmount =
      recoveryValue != null &&
      latestSoldPrice != null &&
      recoveryValue === latestSoldPrice &&
      cogsUnit != null &&
      quantity != null &&
      Math.abs(quantity * cogsUnit - latestSoldPrice) > 0.01;

    const audit: ReadyToFileAuditItem[] = [
      {
        id: "family_eligible",
        label: "Family is removal_shipment_missing or removal_order_discrepancy",
        pass: familyEligible,
        detail: family ?? "unknown",
      },
      {
        id: "not_scanner_or_ocr_only",
        label: "Not scanner-only / not OCR-only",
        pass: !scannerOnly,
        detail: `source_table=${sourceTable ?? "—"}`,
      },
      {
        id: "deterministic_reference_graph",
        label: "Has deterministic reference graph (edges > 0, 0 ambiguous)",
        pass: deterministicGraph,
        detail: `${t?.reference_edge_count ?? 0} edges · ${t?.ambiguous_matches.length ?? 0} ambiguous`,
      },
      {
        id: "has_cogs",
        label: "Has approved COGS",
        pass: hasCogs,
        detail: cogsUnit == null ? "missing" : `$${cogsUnit.toFixed(2)}/unit`,
      },
      {
        id: "has_recovery_value",
        label: "Has recovery value",
        pass: hasRecovery,
        detail: recoveryValue == null ? "missing" : `$${recoveryValue.toFixed(2)}`,
      },
      {
        id: "has_trid_anchor",
        label: "Has TRID / reference anchor",
        pass: hasTridAnchor,
        detail: packet.trid ?? packet.expected_package_id ?? packet.product_link_resolved_product_id ?? "missing",
      },
      {
        id: "has_family_specific_removal_reference",
        label: "Has family-specific removal reference",
        pass: familyRefOk,
        detail:
          family === "removal_shipment_missing"
            ? `removal_shipment_id=${packet.removal_shipment_id ?? "—"}`
            : `removal_order_id=${packet.removal_order_id ?? "—"}`,
      },
      {
        id: "has_filing_packet_evidence",
        label: "Has filing packet / evidence",
        pass: hasEvidence,
        detail: hasEvidence ? "present" : "missing",
      },
      {
        id: "no_fake_scan_codes",
        label: "Does not rely on fake scan codes",
        pass: !usesFakeScanCode,
        detail: usesFakeScanCode ? "fake_scan_code_detected" : "real identifiers only",
      },
      {
        id: "no_simulated_case_ids",
        label: "Does not use simulated case IDs",
        pass: !usesSimulatedCaseId,
        detail: usesSimulatedCaseId ? "simulated_case_id" : "none (placeholder empty)",
      },
      {
        id: "no_sale_price_as_amount",
        label: "Does not use sale price as claim amount",
        pass: !usesSalePriceAsAmount,
        detail: `amount=${recoveryValue ?? "—"} · sale_price=${latestSoldPrice ?? "—"}`,
      },
      {
        id: "has_external_source_reference",
        label: "Has a real external Amazon report/event reference (not only internal DB UUIDs)",
        pass: ledger.external_reference_count > 0,
        detail:
          ledger.external_reference_count > 0
            ? `${ledger.external_reference_count} external ref(s): ${ledger.match_reasons.join(", ") || "—"}`
            : "no external/source reference — needs reference review",
      },
    ];

    const failedAudit = audit.filter((a) => !a.pass).map((a) => a.id);
    const needsReferenceReview = ledger.needs_reference_review;
    const blockers = [...new Set([...packet.blockers, ...failedAudit])];
    const ready = packet.ready_to_file && failedAudit.length === 0;
    const filingStatus = ready
      ? "ready_for_manual_filing"
      : needsReferenceReview
        ? "needs_reference_review"
        : "blocked";

    const moneyLane: ReadyToFileMoneyLane = {
      latest_sold_price: latestSoldPrice,
      latest_sold_price_source: m?.latest_sold_price_source ?? null,
      latest_sold_price_date: m?.latest_sold_price_date ?? null,
      latest_sale_net_deterministic: m?.latest_sale_net_deterministic ?? false,
      sale_match_confidence: m?.sale_match_confidence ?? "none",
      latest_sale_net_unknown_reason: m?.latest_sale_net_unknown_reason ?? null,
      amazon_fees_total: m?.amazon_fees_total ?? null,
      amazon_fees_source: m?.amazon_fees_source ?? null,
      fee_source_confidence: m?.fee_source_confidence ?? "unknown",
      net_settlement_amount: m?.net_settlement_amount ?? null,
      approved_cogs_unit: cogsUnit,
      recovery_value: recoveryValue,
      observed_reimbursement: m?.observed_reimbursement ?? null,
      observed_reimbursement_status: observedStatusLabel(
        m?.observed_reimbursement ?? null,
        m?.reimbursement_status ?? "unknown",
      ),
      currency: packet.fields_to_copy_into_seller_central.currency,
    };

    const reference_health: ReadyToFileReferenceHealth = {
      primary_trid: t?.primary_trid ?? null,
      trid_source: t?.trid_source ?? "unknown",
      trid_confidence: t?.trid_confidence ?? "unknown",
      expected_package_id: packet.expected_package_id,
      product_link_resolved_product_id: packet.product_link_resolved_product_id,
      event_datetime_used_as_filter: EVENT_DATETIME_FILTER_USED,
      event_datetime_note:
        "Event/removal date is stored but is NOT used as a reference-matching join filter; edges match by row id.",
      reference_edge_count: t?.reference_edge_count ?? 0,
      ambiguous_reference_count: t?.ambiguous_matches.length ?? 0,
      edges: (t?.reference_edges ?? []).map((e) => ({
        id: e.id,
        edge_type: e.edge_type,
        reference_kind: e.reference_kind,
        reference_value: e.reference_value,
        source_table: e.to_source_table ?? e.from_source_table,
        source_row_id: e.to_source_row_id ?? e.from_source_row_id,
        confidence_score: e.confidence_score,
        operator_review_status: e.operator_review_status,
      })),
    };

    // Corrected, external-only references for the table column (never a UUID surrogate).
    const externalRemovalOrderId = ledger.removal_order_refs[0] ?? null;
    const externalRemovalShipmentRef = ledger.removal_shipment_refs[0] ?? null;

    rows.push({
      claim_submission_id: subId,
      claim_case_id: packet.claim_case_id,
      claim_family: family,
      filing_status: filingStatus,
      recovery_value: recoveryValue,
      clean_quantity: quantity,
      approved_cogs_unit: cogsUnit,
      fnsku: packet.fnsku,
      sku: packet.sku,
      asin: packet.asin,
      trid_or_expected_package: ledger.primary_reference_anchor.value ?? packet.expected_package_id,
      removal_order_id: externalRemovalOrderId ?? packet.removal_order_id,
      removal_shipment_id: externalRemovalShipmentRef ?? packet.removal_shipment_id,
      evidence_status: hasEvidence ? "present" : "missing",
      filing_packet_status: ready ? "ready" : "blocked",
      amazon_case_id_status: packet.fields_to_record_back.amazon_case_id ? "recorded" : "not_recorded",
      ready_to_file: ready,
      blockers,
      audit,
      scanner_only: scannerOnly,
      uses_fake_scan_code: usesFakeScanCode,
      uses_simulated_case_id: usesSimulatedCaseId,
      uses_sale_price_as_amount: usesSalePriceAsAmount,
      recovery_formula: packet.recovery_formula,
      money_lane: moneyLane,
      reference_health,
      event_reference_ledger: ledger,
      product_identity: {
        fnsku: packet.fnsku,
        sku: packet.sku,
        asin: packet.asin,
        resolved_product_id: packet.product_link_resolved_product_id,
      },
      packet,
      amount_basis_policy_overlay: amountBasisPolicy,
    });
  }

  // Read-only removal-claim origin / missing-basis inputs (PHASE-CLAIM-REMOVAL-ORIGIN-REASON-UI-SURFACE-V1).
  // Resolved separately from money — keeps the "why this claim exists" explanation
  // strictly separate from the latest_sale_net financial calculation.
  const removalOriginInputs = await loadRemovalOriginInputsForRows(
    client,
    organizationId,
    rows,
    missingThresholdDays,
    missingThresholdSource,
  );
  for (const r of rows) {
    r.removal_origin_inputs = removalOriginInputs.get(r.claim_submission_id) ?? null;
  }

  const ready_rows = rows.filter((r) => r.ready_to_file);
  const blocked_rows = rows.filter((r) => !r.ready_to_file);

  const familyCounts: Record<string, number> = {};
  for (const r of rows) {
    const fam = r.claim_family ?? "unknown";
    familyCounts[fam] = (familyCounts[fam] ?? 0) + 1;
  }

  const recoveryKnown = ready_rows
    .map((r) => r.recovery_value)
    .filter((v): v is number => v != null);
  const totalRecovery = recoveryKnown.length > 0 ? Math.round(recoveryKnown.reduce((a, b) => a + b, 0) * 100) / 100 : null;

  const summary_cards: ReadyToFileSummaryCards = {
    ready_to_file_count: ready_rows.length,
    total_recovery_value: totalRecovery,
    families_count: Object.keys(familyCounts).length,
    family_counts: familyCounts,
    missing_blockers_count: blocked_rows.length,
    not_submitted_to_amazon_count: rows.filter((r) => r.amazon_case_id_status === "not_recorded").length,
  };

  return {
    version: CLAIM_READY_TO_FILE_QUEUE_V1,
    route: "/claim-center/ready-to-file",
    pilot_case_run_id: pilotCaseRunId,
    intake_run_id: intakeRunId,
    read_only: true,
    does_not_submit: true,
    summary_cards,
    ready_rows,
    blocked_rows,
    filing_group_matrix: packets.filing_group_matrix,
    scanner_only_claims_detected: rows.filter((r) => r.scanner_only).length,
    simulated_case_ids_used: rows.filter((r) => r.uses_simulated_case_id).length,
    fake_scan_codes_detected: rows.filter((r) => r.uses_fake_scan_code).length,
    sale_price_used_as_amount_detected: rows.filter((r) => r.uses_sale_price_as_amount).length,
    event_reference_ledger_summary: {
      built: true,
      event_datetime_filter_used: EVENT_DATETIME_FILTER_USED,
      event_datetime_note: EVENT_DATETIME_NOTE,
      claims_with_external_references: rows.filter((r) => r.event_reference_ledger.external_reference_count > 0).length,
      claims_needs_reference_review: rows.filter((r) => r.event_reference_ledger.needs_reference_review).length,
    },
    deep_reference_census: deepReferenceCensus,
    settings_audit: settingsAudit,
    case_id_recording: {
      enabled_by_default: false,
      unlock_label: "I filed this manually in Seller Central",
      fields: [
        { key: "amazon_case_id", label: "Amazon Case ID", required: true },
        { key: "filed_at", label: "Filed at", required: true },
        { key: "filed_by", label: "Filed by", required: true },
        { key: "external_case_url", label: "External case URL", required: false },
        { key: "notes", label: "Notes", required: false },
      ],
      does_not_submit_to_amazon: true,
      write_phase_required: "PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-EXECUTE-V1",
      write_guarded: true,
    },
    prerequisites: {
      SAFE_MONEY_LANE_PREVIEW_READY: money.SAFE_MONEY_LANE_PREVIEW_READY,
      recovery_value_coverage: money.recovery_value_coverage,
      trid_coverage_count: trace.trid_coverage_count,
      reference_edges_total: trace.total_reference_edges,
    },
  };
}
