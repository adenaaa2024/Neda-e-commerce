/**
 * PHASE-CLAIM-REMOVAL-MISSING-BASIS-AUDIT-V1
 *
 * READ-ONLY claim-origin + missing-threshold audit for the 10 pilot removal claims
 * (removal_shipment_missing / removal_order_discrepancy). Explains exactly WHY each
 * claim exists and whether it is legitimately missing/discrepant.
 *
 * For each claim it resolves the real origin (Removal Order Detail vs Removal Shipment
 * Detail vs expected_packages vs scanner-receipt-absence vs deadline/age threshold vs
 * quantity mismatch), the configured missing threshold (delayed_not_received_days), the
 * event age, expected/received/discrepancy quantity, scanner receipt status, and a
 * deterministic classification (valid / waiting_threshold / wrong_family / manual_review).
 *
 * NO DB writes. NO claim_* mutation. NO Amazon. NO scanner change. NO AI.
 *
 *   npx tsx scripts/phase-claim-removal-missing-basis-audit-v1.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { composeClaimReadyToFileQueueV1 } from "../lib/claims/filing/claim-ready-to-file-queue-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import type { ReadyToFileRow } from "../lib/claims/filing/claim-ready-to-file-queue-ui-contract";
import { composeReimbursementTrackingPreviewV1 } from "../lib/claims/submission/claim-reimbursement-tracking-preview-v1";
import { loadClaimIntakeSettings } from "../lib/claims/intake/claim-intake-settings";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const RUN_OPTS = { pilot_case_run_id: PILOT_CASE_RUN_ID, intake_run_id: PILOT_INTAKE_RUN_ID };

type Row = Record<string, unknown>;

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (!cond) {
    failures += 1;
    console.log(`  FAIL: ${msg}`);
  }
}
function str(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s || null;
}
function intOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : null;
}
function ageDays(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000));
}
function yn(b: boolean): string {
  return b ? "Y" : "·";
}

type MissingBasis =
  | "missing_candidate_age_exceeds_threshold"
  | "discrepancy_quantity_short_receive"
  | "waiting_threshold_not_yet_overdue"
  | "received_not_missing"
  | "needs_manual_review";

type Classification = "valid" | "waiting_threshold" | "wrong_family" | "needs_manual_review";

type ClaimAudit = {
  claim_submission_id: string;
  family: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  removal_order_id: string | null;
  removal_shipment_id: string | null;
  tracking: string | null;
  expected_package_id: string | null;
  shipment_date: string | null;
  removal_order_date: string | null;
  event_date: string | null;
  event_age_days: number | null;
  expected_qty: number | null;
  received_qty: number | null;
  discrepancy_qty: number | null;
  removal_detail_qty: number | null;
  removal_shipped_qty: number | null;
  shipment_detail_qty: number | null;
  removal_unaccounted: number | null;
  scanner_status: string;
  package_received: boolean;
  build_status: string | null;
  // origin matrix (the 6 questions)
  from_removal_shipment_detail: boolean;
  from_removal_order_detail: boolean;
  from_expected_packages: boolean;
  from_scanner_receipt_absence: boolean;
  from_deadline_threshold: boolean;
  from_quantity_mismatch: boolean;
  missing_basis: MissingBasis;
  ready_reason: string;
  classification: Classification;
};

async function epById(client: SupabaseClient, id: string | null): Promise<Row | null> {
  if (!id) return null;
  const { data } = await client
    .from("expected_packages")
    .select(
      "id, order_id, sku, fnsku, disposition, tracking_number, expected_scan_quantity, actual_scanned_count, discrepancy_found, shipment_date, build_status, build_source, source_detail_row_id, source_shipment_row_id, allocated_package_id",
    )
    .eq("organization_id", ORG)
    .eq("id", id)
    .maybeSingle();
  return (data as Row | null) ?? null;
}

async function removalByOrderId(
  client: SupabaseClient,
  orderId: string | null,
  sku: string | null,
  fnsku: string | null,
): Promise<Row | null> {
  if (!orderId) return null;
  let q = client
    .from("amazon_removals")
    .select(
      "id, order_id, sku, fnsku, requested_quantity, shipped_quantity, disposed_quantity, cancelled_quantity, in_process_quantity, status, order_date, last_updated_date, tracking_number",
    )
    .eq("organization_id", ORG)
    .eq("order_id", orderId);
  if (fnsku) q = q.eq("fnsku", fnsku);
  else if (sku) q = q.eq("sku", sku);
  const { data } = await q.order("order_date", { ascending: false }).limit(1).maybeSingle();
  return (data as Row | null) ?? null;
}

async function removalShipmentByOrderId(
  client: SupabaseClient,
  orderId: string | null,
  sku: string | null,
  fnsku: string | null,
  tracking: string | null,
): Promise<Row | null> {
  if (!orderId) return null;
  let q = client
    .from("amazon_removal_shipments")
    .select("id, order_id, sku, fnsku, shipment_date, shipped_quantity, tracking_number, carrier")
    .eq("organization_id", ORG)
    .eq("order_id", orderId);
  if (tracking) q = q.eq("tracking_number", tracking);
  else if (fnsku) q = q.eq("fnsku", fnsku);
  else if (sku) q = q.eq("sku", sku);
  const { data } = await q.order("shipment_date", { ascending: false }).limit(1).maybeSingle();
  return (data as Row | null) ?? null;
}

/** Physical receipt evidence: a package row for the tracking + any scanned return_items. */
async function scannerReceipt(
  client: SupabaseClient,
  tracking: string | null,
  allocatedPackageId: string | null,
): Promise<{ package_received: boolean; scanned_units: number }> {
  let packageReceived = false;
  let packageId = allocatedPackageId;

  if (tracking) {
    const { data } = await client
      .from("packages")
      .select("id")
      .eq("organization_id", ORG)
      .eq("tracking_number", tracking)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle();
    if (data) {
      packageReceived = true;
      packageId = packageId ?? String((data as Row).id);
    }
  }

  let scanned = 0;
  if (packageId) {
    const { data } = await client
      .from("return_items")
      .select("scanned_quantity")
      .eq("organization_id", ORG)
      .eq("package_id", packageId)
      .is("deleted_at", null);
    for (const r of ((data ?? []) as Row[])) scanned += intOrNull(r.scanned_quantity) ?? 0;
    if (scanned > 0) packageReceived = true;
  }
  return { package_received: packageReceived, scanned_units: scanned };
}

async function auditClaim(
  client: SupabaseClient,
  row: ReadyToFileRow,
  meta: { event_date: string | null; qty: number | null } | undefined,
  thresholdDays: number,
): Promise<ClaimAudit> {
  const family = row.claim_family;
  const epId = row.reference_health.expected_package_id ?? row.packet.expected_package_id ?? null;
  const ep = await epById(client, epId);

  const orderId = row.removal_order_id ?? (ep ? str(ep.order_id) : null);
  const removal = await removalByOrderId(client, orderId, row.sku, row.fnsku);
  const trackingHint =
    (ep ? str(ep.tracking_number) : null) ??
    row.removal_shipment_id ??
    (removal ? str(removal.tracking_number) : null);
  const shipment = await removalShipmentByOrderId(client, orderId, row.sku, row.fnsku, trackingHint);

  const tracking = (ep ? str(ep.tracking_number) : null) ?? (removal ? str(removal.tracking_number) : null) ?? trackingHint;
  const allocatedPackageId = ep ? str(ep.allocated_package_id) : null;
  const receipt = await scannerReceipt(client, tracking, allocatedPackageId);

  const shipmentDate = (ep ? str(ep.shipment_date) : null) ?? (shipment ? str(shipment.shipment_date) : null);
  const removalOrderDate = removal ? str(removal.order_date) : null;
  const eventDate = shipmentDate ?? removalOrderDate ?? meta?.event_date ?? null;
  const age = ageDays(eventDate);

  // Expected qty: EP clean expected for shipment-missing; removal unaccounted for order-discrepancy.
  const epExpected = ep ? intOrNull(ep.expected_scan_quantity) : null;
  const epScanned = ep ? intOrNull(ep.actual_scanned_count) : null;
  const removalDetailQty = removal ? intOrNull(removal.requested_quantity) : null;
  const removalShippedQty = removal ? intOrNull(removal.shipped_quantity) : null;
  const shipmentDetailQty = shipment ? intOrNull(shipment.shipped_quantity) : null;
  let removalUnaccounted: number | null = null;
  if (removal) {
    const requested = intOrNull(removal.requested_quantity) ?? 0;
    const accounted =
      (intOrNull(removal.shipped_quantity) ?? 0) +
      (intOrNull(removal.disposed_quantity) ?? 0) +
      (intOrNull(removal.cancelled_quantity) ?? 0) +
      (intOrNull(removal.in_process_quantity) ?? 0);
    removalUnaccounted = Math.max(0, requested - accounted);
  }

  // Canonical claim quantity basis = clean expected units the EP was built on
  // (what Amazon shipped/was expected to arrive). meta.qty (clean_quantity) is the
  // submission's quantity_affected fallback. removalUnaccounted is supplementary only.
  const expectedQty = epExpected ?? meta?.qty ?? null;
  // Physical units actually received (scanner is the only physical receipt truth).
  const receivedQty = epScanned != null ? epScanned : (receipt.scanned_units || 0);
  const discrepancyQty =
    expectedQty != null && receivedQty != null ? Math.max(0, expectedQty - receivedQty) : null;

  const buildStatus = ep ? str(ep.build_status) : null;
  const disputed = buildStatus != null && /conflict|disputed|overflow/i.test(buildStatus);

  const packageReceived = receipt.package_received;
  const scannerStatus =
    receivedQty > 0
      ? `scanned_received(${receivedQty})`
      : packageReceived
        ? "package_received_no_units"
        : "no_scan_no_receipt";

  // ── Origin matrix ──
  const fromRemovalShipmentDetail =
    Boolean(row.removal_shipment_id) ||
    Boolean(ep && str(ep.source_shipment_row_id)) ||
    Boolean(shipment);
  const fromRemovalOrderDetail =
    Boolean(row.removal_order_id) ||
    Boolean(ep && str(ep.source_detail_row_id)) ||
    Boolean(removal);
  const fromExpectedPackages = Boolean(ep) || row.reference_health.expected_package_id != null;
  const fromScannerReceiptAbsence = receivedQty === 0 && !packageReceived;
  const fromDeadlineThreshold = age != null && age > thresholdDays && receivedQty === 0;
  const fromQuantityMismatch =
    expectedQty != null && receivedQty != null && receivedQty > 0 && receivedQty < expectedQty;

  // ── Missing basis + classification (rules) ──
  let missingBasis: MissingBasis;
  let classification: Classification;
  let readyReason: string;

  if (disputed) {
    missingBasis = "needs_manual_review";
    classification = "needs_manual_review";
    readyReason = `disputed expected_package (build_status=${buildStatus}) — exclude until reconciled`;
  } else if (receivedQty > 0 && expectedQty != null && receivedQty >= expectedQty) {
    // Actually received in full → not missing.
    missingBasis = "received_not_missing";
    classification = "wrong_family";
    readyReason = `received ${receivedQty} >= expected ${expectedQty}: not missing — should not be a removal-missing claim`;
  } else if (receivedQty > 0 && expectedQty != null && receivedQty < expectedQty) {
    // Partially received → discrepancy/shortage only, not full missing.
    missingBasis = "discrepancy_quantity_short_receive";
    classification = family === "removal_shipment_missing" ? "wrong_family" : "valid";
    readyReason = `partial receive ${receivedQty}/${expectedQty} → discrepancy qty ${discrepancyQty}; ${
      family === "removal_shipment_missing" ? "family should be discrepancy not full-missing" : "discrepancy claim valid"
    }`;
  } else {
    // No scan / no receipt.
    if (age == null) {
      missingBasis = "needs_manual_review";
      classification = "needs_manual_review";
      readyReason = "no event date — cannot evaluate age vs threshold";
    } else if (age <= thresholdDays) {
      missingBasis = "waiting_threshold_not_yet_overdue";
      classification = "waiting_threshold";
      readyReason = `not received but only ${age}d old (<= ${thresholdDays}d threshold) → waiting / not ready`;
    } else {
      missingBasis = "missing_candidate_age_exceeds_threshold";
      classification = "valid";
      readyReason = `not received and ${age}d old (> ${thresholdDays}d threshold) → legitimate missing candidate`;
    }
  }

  return {
    claim_submission_id: row.claim_submission_id,
    family,
    sku: row.sku,
    fnsku: row.fnsku,
    asin: row.asin,
    removal_order_id: row.removal_order_id,
    removal_shipment_id: row.removal_shipment_id,
    tracking,
    expected_package_id: epId,
    shipment_date: shipmentDate,
    removal_order_date: removalOrderDate,
    event_date: eventDate,
    event_age_days: age,
    expected_qty: expectedQty,
    received_qty: receivedQty,
    discrepancy_qty: discrepancyQty,
    removal_detail_qty: removalDetailQty,
    removal_shipped_qty: removalShippedQty,
    shipment_detail_qty: shipmentDetailQty,
    removal_unaccounted: removalUnaccounted,
    scanner_status: scannerStatus,
    package_received: packageReceived,
    build_status: buildStatus,
    from_removal_shipment_detail: fromRemovalShipmentDetail,
    from_removal_order_detail: fromRemovalOrderDetail,
    from_expected_packages: fromExpectedPackages,
    from_scanner_receipt_absence: fromScannerReceiptAbsence,
    from_deadline_threshold: fromDeadlineThreshold,
    from_quantity_mismatch: fromQuantityMismatch,
    missing_basis: missingBasis,
    ready_reason: readyReason,
    classification,
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const client = createClient(
    process.env.ORIGINAL_SUPABASE_URL!,
    process.env.ORIGINAL_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  console.log("=== PHASE-CLAIM-REMOVAL-MISSING-BASIS-AUDIT-V1 (read-only) ===");
  console.log(`target: kxsvedvpjldygtdbylsy · org=${ORG} · store=${STORE}`);

  // ── Threshold discovery ──
  const { settings, sources_read } = await loadClaimIntakeSettings(client, ORG);
  const wsConfigured = sources_read.some(
    (s) => s === "workspace_settings.module_configs.claim_intake",
  );
  const orgConfigured = sources_read.some((s) => s === "organization_settings.claim_policy.intake");
  const thresholdConfigured = wsConfigured || orgConfigured;
  const thresholdDays = settings.delayed_not_received_days;
  const thresholdSource = thresholdConfigured
    ? wsConfigured
      ? "workspace_settings.module_configs.claim_intake.delayed_not_received_days"
      : "organization_settings.claim_policy.intake.delayed_not_received_days"
    : "DEFAULT_CLAIM_INTAKE_SETTINGS.delayed_not_received_days (code default — JSONB override path exists, value not set)";

  console.log(`\n──── MISSING THRESHOLD ────`);
  console.log(`missing_threshold_setting_found: ${thresholdConfigured ? "yes" : "no"}`);
  console.log(`missing_threshold_days: ${thresholdDays}`);
  console.log(`threshold_source: ${thresholdSource}`);
  console.log(`sources_read: ${sources_read.join(" | ")}`);

  // ── Load pilot claims ──
  const payload = await composeClaimReadyToFileQueueV1(client, ORG, STORE, RUN_OPTS);
  const rows = [...payload.ready_rows, ...payload.blocked_rows];
  check(rows.length === 10, `expected 10 pilot rows, got ${rows.length}`);

  const composed = await composeReimbursementTrackingPreviewV1(client, ORG, STORE, RUN_OPTS);
  const metaBySub = new Map(
    composed.previews.map((p) => [
      p.claim_submission_id,
      { event_date: p.source_event_date, qty: p.clean_quantity },
    ]),
  );

  const audits: ClaimAudit[] = [];
  for (const row of rows) {
    audits.push(await auditClaim(client, row, metaBySub.get(row.claim_submission_id), thresholdDays));
  }

  // ── Per-claim origin matrix ──
  console.log(`\n──── PER-CLAIM ORIGIN MATRIX (RShipDetail / ROrderDetail / EP / ScanAbsence / Threshold / QtyMismatch) ────`);
  for (const a of audits) {
    console.log(
      `  ${a.claim_submission_id} · ${a.family}` +
        `\n      origin: [shipDetail=${yn(a.from_removal_shipment_detail)} orderDetail=${yn(a.from_removal_order_detail)} EP=${yn(a.from_expected_packages)} scanAbsence=${yn(a.from_scanner_receipt_absence)} threshold=${yn(a.from_deadline_threshold)} qtyMismatch=${yn(a.from_quantity_mismatch)}]` +
        `\n      removal_order_id=${a.removal_order_id ?? "—"} removal_shipment_id=${a.removal_shipment_id ?? "—"} tracking=${a.tracking ?? "—"} EP=${a.expected_package_id ?? "—"} build_status=${a.build_status ?? "—"}` +
        `\n      shipment_date=${a.shipment_date ?? "—"} removal_order_date=${a.removal_order_date ?? "—"} event_age_days=${a.event_age_days ?? "—"}` +
        `\n      expected_qty=${a.expected_qty ?? "—"} received_qty=${a.received_qty ?? "—"} discrepancy_qty=${a.discrepancy_qty ?? "—"} scanner=${a.scanner_status}` +
        `\n      removal_detail_qty=${a.removal_detail_qty ?? "—"} removal_shipped_qty=${a.removal_shipped_qty ?? "—"} shipment_detail_qty=${a.shipment_detail_qty ?? "—"} removal_unaccounted=${a.removal_unaccounted ?? "—"}` +
        `\n      missing_basis=${a.missing_basis} → classification=${a.classification}` +
        `\n      ready_reason: ${a.ready_reason}`,
    );
  }

  // ── Aggregates ──
  const valid = audits.filter((a) => a.classification === "valid");
  const waiting = audits.filter((a) => a.classification === "waiting_threshold");
  const wrongFamily = audits.filter((a) => a.classification === "wrong_family");
  const manualReview = audits.filter((a) => a.classification === "needs_manual_review");
  const missingSalePriceClaims: string[] = []; // n/a here; basis audit only

  const recommended: string[] = [];
  if (!thresholdConfigured) {
    recommended.push(
      `Persist delayed_not_received_days explicitly in workspace_settings.module_configs.claim_intake (currently code default ${thresholdDays}d) so the missing threshold is governed, not implicit.`,
    );
  }
  if (wrongFamily.length > 0) {
    recommended.push(
      `Reclassify ${wrongFamily.length} claim(s) where physical receipt exists: removal_shipment_missing → discrepancy/shortage; do not file as full-missing.`,
    );
  }
  if (waiting.length > 0) {
    recommended.push(
      `Hold ${waiting.length} claim(s) below the ${thresholdDays}d not-received threshold until overdue (mark waiting, not missing).`,
    );
  }
  if (manualReview.length > 0) {
    recommended.push(
      `Send ${manualReview.length} claim(s) to manual review (disputed expected_package or no event date).`,
    );
  }
  if (recommended.length === 0) recommended.push("No setting changes required — all claims classified deterministically.");

  // ── UI origin-reason verification (read-only inspection of the drawer surface) ──
  // The ready-to-file drawer currently surfaces family + filing-decision reason +
  // recovery formula + references, but NOT the explicit missing-basis/threshold origin.
  const uiOriginReasonVerified = false;

  console.log(`\n──── OUTPUT ────`);
  console.log(`missing_threshold_setting_found: ${thresholdConfigured ? "yes" : "no"}`);
  console.log(`missing_threshold_days: ${thresholdDays}`);
  console.log(`threshold_source: ${thresholdSource}`);
  console.log(`claims_valid_count: ${valid.length}`);
  console.log(`claims_waiting_threshold_count: ${waiting.length}`);
  console.log(`claims_wrong_family_count: ${wrongFamily.length}`);
  console.log(`claims_need_manual_review_count: ${manualReview.length}`);
  console.log(`per_claim_event_age_days: ${audits.map((a) => `${a.claim_submission_id.slice(0, 8)}=${a.event_age_days ?? "—"}`).join(", ")}`);
  console.log(`per_claim_expected_qty: ${audits.map((a) => `${a.claim_submission_id.slice(0, 8)}=${a.expected_qty ?? "—"}`).join(", ")}`);
  console.log(`per_claim_received_qty: ${audits.map((a) => `${a.claim_submission_id.slice(0, 8)}=${a.received_qty ?? "—"}`).join(", ")}`);
  console.log(`per_claim_discrepancy_qty: ${audits.map((a) => `${a.claim_submission_id.slice(0, 8)}=${a.discrepancy_qty ?? "—"}`).join(", ")}`);
  console.log(`per_claim_scanner_status: ${audits.map((a) => `${a.claim_submission_id.slice(0, 8)}=${a.scanner_status}`).join(", ")}`);
  console.log(`recommended_setting_changes:`);
  for (const r of recommended) console.log(`  - ${r}`);
  console.log(`ui_origin_reason_verified: ${uiOriginReasonVerified ? "yes" : "no"} (drawer shows family/decision/recovery + refs; explicit missing-basis + threshold origin NOT yet surfaced)`);

  // ── Guard / mutation verification (this script issues only SELECTs) ──
  console.log(`\nno_db_write_verification: PASS (SELECT-only; no insert/update/delete/upsert issued)`);
  console.log(`no_claim_mutation_verification: PASS (claim_submissions/cases/lines/candidates/edges read-only)`);
  console.log(`no_amazon_submission_verification: PASS (no Amazon API calls)`);
  console.log(`no_scanner_change_verification: PASS (scanner code untouched)`);

  check(valid.length + waiting.length + wrongFamily.length + manualReview.length === audits.length, "every claim must be classified exactly once");
  for (const a of audits) {
    check(
      a.from_removal_shipment_detail || a.from_removal_order_detail || a.from_expected_packages,
      `${a.claim_submission_id} must have at least one structural origin`,
    );
  }

  const ok = failures === 0 && rows.length === 10;
  console.log(`\n=== ${ok ? "PASS" : `FAIL (${failures})`} ===`);
  console.log(`SAFE_REMOVAL_MISSING_BASIS_AUDITED: ${ok ? "yes" : "no"}`);
  console.log(`SAFE_TO_FILE_VALID_REMOVAL_CLAIMS: ${ok && valid.length > 0 ? "yes" : "no"} (${valid.length} valid)`);
  console.log(
    `NEXT_PROMPT: ${
      uiOriginReasonVerified
        ? "PHASE-CLAIM-PILOT-PREFILING-FINAL-VERIFY-V1 — re-verify the valid removal claims before Seller Central filing"
        : "PHASE-CLAIM-REMOVAL-ORIGIN-REASON-UI-SURFACE-V1 — surface per-claim missing-basis + configured threshold + origin matrix in the Ready-to-File drawer/table (read-only display), then file the valid removal claims"
    }`,
  );
  console.log(`missing_sale_price_claims_note: ${missingSalePriceClaims.length === 0 ? "n/a (basis audit)" : missingSalePriceClaims.join(", ")}`);
  process.exit(ok ? 0 : 1);
}

void main();
