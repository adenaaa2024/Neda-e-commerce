/**
 * Phase 7F — live claim trigger emitters.
 *
 * Wires scanner/review events to the unified claim candidate pool:
 *   * per_problem_scan        — problem scan saved
 *   * box_close               — box review finalized (box scope only)
 *   * shipment_review_close   — Shipment Receive Review closed (aggregates child boxes;
 *                               a single-box shipment IS the box review)
 *   * order_resolved          — reference/order scope fully resolved (emitter ready; no live hook yet)
 *
 * Hard rules: claim_candidates only (never claim_cases/claim_lines); one candidate per
 * event; product is attribute not grain; dedupe_key identical to the scheduled
 * generators so live + scheduled converge on the same rows; legacy_seed never truth.
 * Every write path goes through the registry apply engine (dedupe + identity-conflict
 * skip + legacy corroboration metadata only).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  candidateTriggerAllowsRun,
  isPhysicalEventClaimable,
  loadClaimCandidateIntakePolicy,
  physicalEventFromScannerSignals,
  type ClaimCandidateIntakePolicy,
  type ClaimablePhysicalEvent,
  type IntakeRunKind,
} from "../../claim-candidate-intake-policy";
import { returnItemNotesMarkOffSlip } from "../../scanner/item-scan-off-slip";
import { shouldExcludeReturnItemFromScannerCounts } from "../../scanner/return-items-test-data-guard";
import { buildSlipShipmentValidationPreview } from "../../scanner/slip-shipment-validation";
import { applyDrafts, countLegacyOverlap } from "./claim-generator-registry";
import { evaluateSourceGate, loadClaimIntakeSettings } from "./claim-intake-settings";
import {
  buildClaimDedupeKey,
  type ClaimCandidateDraft,
  type ClaimReferenceEdge,
} from "./claim-intake-types";

type Row = Record<string, unknown>;

export type LiveEmitResult = {
  ok: boolean;
  trigger: IntakeRunKind;
  emitted: number;
  updated: number;
  skipped: number;
  legacy_corroborated: number;
  skip_reason: string | null;
  run_id: string | null;
};

function noop(trigger: IntakeRunKind, reason: string): LiveEmitResult {
  return {
    ok: true,
    trigger,
    emitted: 0,
    updated: 0,
    skipped: 0,
    legacy_corroborated: 0,
    skip_reason: reason,
    run_id: null,
  };
}

function str(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s || null;
}

function intOrZero(v: unknown): number {
  const n = Math.floor(Number(v ?? 0));
  return Number.isFinite(n) ? n : 0;
}

function edgeList(pairs: Array<[string, unknown]>): ClaimReferenceEdge[] {
  const out: ClaimReferenceEdge[] = [];
  const seen = new Set<string>();
  for (const [kind, value] of pairs) {
    const v = str(value);
    if (!v) continue;
    const k = `${kind}\u0000${v}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ reference_kind: kind, reference_value: v });
  }
  return out;
}

/** Live-emitter draft builder — dedupe-compatible with the scheduled generators. */
function liveDraft(input: {
  organizationId: string;
  storeId: string | null;
  source_kind: "scanner_physical_review";
  claim_family: string;
  claim_reason: string;
  source_table: string;
  source_row_id: string;
  trigger: IntakeRunKind;
  product: { sku: string | null; fnsku: string | null; asin: string | null; resolved_product_id: string | null };
  reference_key: string | null;
  reference_type: string | null;
  expected_quantity?: number | null;
  actual_quantity?: number | null;
  event_date?: string | null;
  physical_event: ClaimablePhysicalEvent;
  shipment_scope_key: string | null;
  package_id?: string | null;
  pallet_id?: string | null;
  return_item_id?: string | null;
  expected_package_id?: string | null;
  reference_edges?: ClaimReferenceEdge[];
  extra_metadata?: Record<string, unknown>;
}): ClaimCandidateDraft {
  const expected = input.expected_quantity ?? null;
  const actual = input.actual_quantity ?? null;
  return {
    source_kind: input.source_kind,
    claim_family: input.claim_family,
    dedupe_key: buildClaimDedupeKey({
      source_kind: input.source_kind,
      organization_id: input.organizationId,
      store_id: input.storeId,
      source_table: input.source_table,
      source_row_id: input.source_row_id,
      claim_family: input.claim_family,
    }),
    source_event_key: input.source_row_id,
    source_table: input.source_table,
    source_row_id: input.source_row_id,
    organization_id: input.organizationId,
    store_id: input.storeId,
    product: input.product,
    reference_key: input.reference_key,
    reference_type: input.reference_type,
    expected_quantity: expected,
    actual_quantity: actual,
    delta_quantity: expected != null && actual != null ? actual - expected : null,
    expected_amount: null,
    currency: null,
    event_date: input.event_date ?? new Date().toISOString(),
    dispute_deadline: null,
    days_remaining: null,
    recovery_value: null,
    cogs_unit: null,
    evidence_summary: null,
    claim_reason: input.claim_reason,
    confidence_score: 0.9,
    evidence_pointers: [{ table: input.source_table, id: input.source_row_id }],
    reference_edges: input.reference_edges ?? [],
    metadata: {
      intake_version: "7f-live-v1",
      live_trigger: input.trigger,
      physical_event: input.physical_event,
      shipment_scope_key: input.shipment_scope_key,
      package_id: input.package_id ?? null,
      pallet_id: input.pallet_id ?? null,
      return_item_id: input.return_item_id ?? null,
      expected_package_id: input.expected_package_id ?? null,
      ...input.extra_metadata,
    },
  };
}

/** Policy + source-kind + purchased gate shared by every live emitter. */
async function gateLiveEmission(
  client: SupabaseClient,
  organizationId: string,
  runKind: IntakeRunKind,
): Promise<{ ok: true; policy: ClaimCandidateIntakePolicy } | { ok: false; reason: string }> {
  const policy = await loadClaimCandidateIntakePolicy(client, organizationId);
  if (!candidateTriggerAllowsRun(policy.claim_candidate_trigger, runKind)) {
    return { ok: false, reason: `trigger_${policy.claim_candidate_trigger}_disallows_${runKind}` };
  }
  const { settings } = await loadClaimIntakeSettings(client, organizationId);
  const gate = evaluateSourceGate(settings, "scanner_physical_review");
  if (gate.skip_reason) return { ok: false, reason: gate.skip_reason };
  return { ok: true, policy };
}

async function persistDrafts(
  client: SupabaseClient,
  organizationId: string,
  trigger: IntakeRunKind,
  drafts: ClaimCandidateDraft[],
): Promise<LiveEmitResult> {
  if (!drafts.length) return noop(trigger, "no_claimable_events");
  const runId = crypto.randomUUID();
  const legacyOverlap = await countLegacyOverlap(client, organizationId, drafts);
  const stats = await applyDrafts(client, organizationId, drafts, legacyOverlap, runId);
  return {
    ok: true,
    trigger,
    emitted: stats.inserted,
    updated: stats.updated_existing_trusted,
    skipped: stats.skipped_identity_conflict,
    legacy_corroborated: stats.legacy_corroborated,
    skip_reason: null,
    run_id: runId,
  };
}

function productOf(row: Row) {
  return {
    sku: str(row.sku),
    fnsku: str(row.fnsku),
    asin: str(row.asin),
    resolved_product_id: str(row.resolved_product_id),
  };
}

const RETURN_ITEM_SELECT =
  "id, organization_id, store_id, package_id, pallet_id, order_id, sku, fnsku, asin, product_identifier, item_name, notes, conditions, scanned_quantity, resolved_product_id, created_at";

function unitConditionDraft(
  organizationId: string,
  trigger: IntakeRunKind,
  policy: ClaimCandidateIntakePolicy,
  row: Row,
  shipmentScopeKey: string | null,
): ClaimCandidateDraft | null {
  if (
    shouldExcludeReturnItemFromScannerCounts({
      item_name: str(row.item_name),
      sku: str(row.sku),
      fnsku: str(row.fnsku),
      product_identifier: str(row.product_identifier),
      notes: str(row.notes),
    })
  ) {
    return null;
  }
  const event = physicalEventFromScannerSignals({
    conditionTags: Array.isArray(row.conditions) ? row.conditions.map((c) => String(c ?? "")) : [],
    offSlip: returnItemNotesMarkOffSlip(str(row.notes)),
  });
  if (!event || !isPhysicalEventClaimable(policy, event)) return null;
  return liveDraft({
    organizationId,
    storeId: str(row.store_id),
    source_kind: "scanner_physical_review",
    claim_family: "physical_return_issue",
    claim_reason:
      event === "unexpected_item" ? "scanned_off_manifest_unit" : `operator_flagged_${event}`,
    source_table: "return_items",
    source_row_id: String(row.id),
    trigger,
    product: productOf(row),
    reference_key: str(row.order_id) ?? str(row.package_id),
    reference_type: str(row.order_id) ? "order_id" : "package_id",
    actual_quantity: intOrZero(row.scanned_quantity) || 1,
    event_date: str(row.created_at),
    physical_event: event,
    shipment_scope_key: shipmentScopeKey,
    package_id: str(row.package_id),
    pallet_id: str(row.pallet_id),
    return_item_id: String(row.id),
    reference_edges: edgeList([
      ["order_id", row.order_id],
      ["package_id", row.package_id],
      ["pallet_id", row.pallet_id],
      ["tracking_number", shipmentScopeKey],
    ]),
    extra_metadata: { conditions: row.conditions ?? null },
  });
}

/* ── 1) per_problem_scan ─────────────────────────────────────────────────── */
export async function emitPerProblemScanCandidate(
  client: SupabaseClient,
  args: { organizationId: string; returnItemId: string },
): Promise<LiveEmitResult> {
  const trigger: IntakeRunKind = "live_scan";
  const gate = await gateLiveEmission(client, args.organizationId, trigger);
  if (!gate.ok) return noop(trigger, gate.reason);

  const { data, error } = await client
    .from("return_items")
    .select(RETURN_ITEM_SELECT)
    .eq("id", args.returnItemId)
    .eq("organization_id", args.organizationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error || !data) return noop(trigger, error?.message ?? "return_item_not_found");
  const row = data as unknown as Row;

  let shipmentScopeKey: string | null = null;
  const packageId = str(row.package_id);
  if (packageId) {
    const { data: pkg } = await client
      .from("packages")
      .select("tracking_number")
      .eq("id", packageId)
      .maybeSingle();
    shipmentScopeKey = str((pkg as Row | null)?.tracking_number);
  }

  const draft = unitConditionDraft(args.organizationId, trigger, gate.policy, row, shipmentScopeKey);
  if (!draft) return noop(trigger, "event_not_claimable_or_no_signal");
  return persistDrafts(client, args.organizationId, trigger, [draft]);
}

/* ── shared box-scope event collection (used by box_close + shipment_review_close) ── */
async function collectBoxEventDrafts(
  client: SupabaseClient,
  organizationId: string,
  policy: ClaimCandidateIntakePolicy,
  trigger: IntakeRunKind,
  pkg: { id: string; store_id: string | null; tracking_number: string | null },
  shipmentScopeKey: string | null,
): Promise<ClaimCandidateDraft[]> {
  const drafts: ClaimCandidateDraft[] = [];
  const scope = shipmentScopeKey ?? pkg.tracking_number;

  // a) unit condition events (damaged / wrong_item / expired / missing / unexpected)
  const { data: items } = await client
    .from("return_items")
    .select(RETURN_ITEM_SELECT)
    .eq("package_id", pkg.id)
    .eq("organization_id", organizationId)
    .is("deleted_at", null);
  for (const row of ((items ?? []) as unknown) as Row[]) {
    const draft = unitConditionDraft(organizationId, trigger, policy, row, scope);
    if (draft) drafts.push(draft);
  }

  // b) validation buckets — over_received / missing / empty_box at box grain
  const preview = await buildSlipShipmentValidationPreview(client, organizationId, pkg.id);
  if ("error" in preview) return drafts;

  for (const line of preview.lines) {
    const product = {
      sku: line.grain.sku,
      fnsku: line.grain.fnsku,
      asin: line.grain.asin,
      resolved_product_id: line.grain.resolved_product_id,
    };
    const baseRef = {
      reference_key: scope ?? pkg.id,
      reference_type: scope ? "tracking_number" : "package_id",
    };

    if (line.bucket === "over_scanned" && isPhysicalEventClaimable(policy, "over_received")) {
      const anchorId = line.slip_content_ids[0] ?? line.return_item_ids[0] ?? pkg.id;
      const anchorTable = line.slip_content_ids[0]
        ? "slip_contents"
        : line.return_item_ids[0]
          ? "return_items"
          : "packages";
      drafts.push(
        liveDraft({
          organizationId,
          storeId: pkg.store_id,
          source_kind: "scanner_physical_review",
          claim_family: "over_received",
          claim_reason: "quantity_over_received",
          source_table: anchorTable,
          source_row_id: anchorId,
          trigger,
          product,
          ...baseRef,
          expected_quantity: Math.max(line.slip_qty, line.shipment_expected_qty),
          actual_quantity: line.scanned_qty,
          physical_event: "over_received",
          shipment_scope_key: scope,
          package_id: pkg.id,
          return_item_id: line.return_item_ids[0] ?? null,
          reference_edges: edgeList([
            ["tracking_number", scope],
            ["package_id", pkg.id],
          ]),
          extra_metadata: { validation_bucket: line.bucket, label: line.label },
        }),
      );
    }

    const missingQty = line.recorded_missing_qty + line.remaining_missing_qty;
    if (
      (line.bucket === "pending_under_scanned" || line.bucket === "final_missing_after_pallet_close") &&
      missingQty > 0 &&
      isPhysicalEventClaimable(policy, "missing") &&
      line.slip_content_ids[0]
    ) {
      drafts.push(
        liveDraft({
          organizationId,
          storeId: pkg.store_id,
          source_kind: "scanner_physical_review",
          claim_family: "missing_units",
          claim_reason: "quantity_short_recorded",
          source_table: "slip_contents",
          source_row_id: line.slip_content_ids[0],
          trigger,
          product,
          ...baseRef,
          expected_quantity: Math.max(line.slip_qty, line.shipment_expected_qty),
          actual_quantity: line.scanned_qty,
          physical_event: "missing",
          shipment_scope_key: scope,
          package_id: pkg.id,
          expected_package_id: line.expected_package_ids[0] ?? null,
          reference_edges: edgeList([
            ["tracking_number", scope],
            ["package_id", pkg.id],
          ]),
          extra_metadata: { validation_bucket: line.bucket, label: line.label },
        }),
      );
    }
  }

  const expectedUnits = Math.max(preview.totals.slip_units, preview.totals.shipment_expected_units);
  if (
    preview.totals.scanned_units === 0 &&
    expectedUnits > 0 &&
    isPhysicalEventClaimable(policy, "empty_box")
  ) {
    drafts.push(
      liveDraft({
        organizationId,
        storeId: pkg.store_id,
        source_kind: "scanner_physical_review",
        claim_family: "empty_box_received",
        claim_reason: "empty_box_with_expected_units",
        source_table: "packages",
        source_row_id: pkg.id,
        trigger,
        product: { sku: null, fnsku: null, asin: null, resolved_product_id: null },
        reference_key: scope ?? pkg.id,
        reference_type: scope ? "tracking_number" : "package_id",
        expected_quantity: expectedUnits,
        actual_quantity: 0,
        physical_event: "empty_box",
        shipment_scope_key: scope,
        package_id: pkg.id,
        reference_edges: edgeList([
          ["tracking_number", scope],
          ["package_id", pkg.id],
        ]),
      }),
    );
  }

  return drafts;
}

async function loadPackage(
  client: SupabaseClient,
  organizationId: string,
  packageId: string,
): Promise<{ id: string; store_id: string | null; tracking_number: string | null } | null> {
  const { data } = await client
    .from("packages")
    .select("id, store_id, tracking_number")
    .eq("id", packageId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return null;
  const row = data as Row;
  return { id: String(row.id), store_id: str(row.store_id), tracking_number: str(row.tracking_number) };
}

/* ── 2) box_close ────────────────────────────────────────────────────────── */
export async function emitBoxCloseCandidates(
  client: SupabaseClient,
  args: { organizationId: string; packageId: string },
): Promise<LiveEmitResult> {
  const trigger: IntakeRunKind = "box_close";
  const gate = await gateLiveEmission(client, args.organizationId, trigger);
  if (!gate.ok) return noop(trigger, gate.reason);

  const pkg = await loadPackage(client, args.organizationId, args.packageId);
  if (!pkg) return noop(trigger, "package_not_found");

  const drafts = await collectBoxEventDrafts(
    client,
    args.organizationId,
    gate.policy,
    trigger,
    pkg,
    pkg.tracking_number,
  );
  return persistDrafts(client, args.organizationId, trigger, drafts);
}

/* ── 3) shipment_review_close ────────────────────────────────────────────── */
export async function emitShipmentReviewCloseCandidates(
  client: SupabaseClient,
  args: { organizationId: string; storeId: string; trackingNumber: string },
): Promise<LiveEmitResult & { boxes_in_scope: number }> {
  const trigger: IntakeRunKind = "shipment_review_close";
  const gate = await gateLiveEmission(client, args.organizationId, trigger);
  if (!gate.ok) return { ...noop(trigger, gate.reason), boxes_in_scope: 0 };

  const { data: pkgs, error } = await client
    .from("packages")
    .select("id, store_id, tracking_number")
    .eq("organization_id", args.organizationId)
    .eq("store_id", args.storeId)
    .eq("tracking_number", args.trackingNumber)
    .is("deleted_at", null);
  if (error) return { ...noop(trigger, error.message), boxes_in_scope: 0 };

  const boxes = ((pkgs ?? []) as Row[]).map((row) => ({
    id: String(row.id),
    store_id: str(row.store_id),
    tracking_number: str(row.tracking_number),
  }));
  if (!boxes.length) return { ...noop(trigger, "no_packages_in_shipment_scope"), boxes_in_scope: 0 };

  // Single box: the box review IS the shipment review. Multiple: aggregate all child scopes.
  const drafts: ClaimCandidateDraft[] = [];
  for (const box of boxes) {
    drafts.push(
      ...(await collectBoxEventDrafts(
        client,
        args.organizationId,
        gate.policy,
        trigger,
        box,
        args.trackingNumber,
      )),
    );
  }
  const result = await persistDrafts(client, args.organizationId, trigger, drafts);
  return { ...result, boxes_in_scope: boxes.length };
}

/* ── 4) order_resolved (emitter ready; live hook lands with TRID resolution flow) ── */
export async function emitOrderResolvedCandidates(
  client: SupabaseClient,
  args: { organizationId: string; orderId: string },
): Promise<LiveEmitResult> {
  const trigger: IntakeRunKind = "order_resolved";
  const gate = await gateLiveEmission(client, args.organizationId, trigger);
  if (!gate.ok) return noop(trigger, gate.reason);

  const { data: items, error } = await client
    .from("return_items")
    .select(RETURN_ITEM_SELECT)
    .eq("organization_id", args.organizationId)
    .eq("order_id", args.orderId)
    .is("deleted_at", null);
  if (error) return noop(trigger, error.message);

  const drafts: ClaimCandidateDraft[] = [];
  for (const row of ((items ?? []) as unknown) as Row[]) {
    const draft = unitConditionDraft(args.organizationId, trigger, gate.policy, row, null);
    if (draft) drafts.push(draft);
  }
  return persistDrafts(client, args.organizationId, trigger, drafts);
}
