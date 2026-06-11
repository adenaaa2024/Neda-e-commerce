/**
 * Phase 7G — claim evidence packet composer.
 * Single or grouped candidates -> structured packet (index + per-event sections +
 * warnings). Read-only over the pool: never writes candidates, never touches
 * claim_cases/claim_lines, never submits anything.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  evaluateManualGroupingPolicy,
  loadClaimCandidateIntakePolicy,
  MANUAL_GROUPING_WARNING_LABELS,
} from "../../claim-candidate-intake-policy";
import { loadMaterializedCandidateEdges } from "../edges/claim-reference-edge-materializer";
import type {
  ClaimEvidencePacket,
  ComposePacketResult,
  PacketEventSection,
  PacketIndexLine,
  PacketPhoto,
  PacketReferenceEdge,
  PacketTimelineEntry,
  PacketWarning,
} from "./claim-evidence-packet-types";

type Row = Record<string, unknown>;

function str(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s || null;
}

function num(v: unknown): number | null {
  const n = Number(v ?? NaN);
  return Number.isFinite(n) ? n : null;
}

/** Tables the composer may snapshot (claim source whitelist — never claim_candidates itself). */
const SNAPSHOT_TABLES = new Set([
  "return_items",
  "slip_contents",
  "packages",
  "expected_packages",
  "amazon_removals",
  "amazon_removal_shipments",
  "amazon_reimbursements",
  "amazon_settlements",
  "amazon_transactions",
  "amazon_inventory_ledger",
  "amazon_safet_claims",
  "amazon_returns",
]);

const SNAPSHOT_DROP_KEYS = new Set(["raw_data", "raw_row", "raw_return_data", "manifest_data", "photo_evidence"]);

function sanitizeSnapshot(row: Row): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (SNAPSHOT_DROP_KEYS.has(k)) {
      out[k] = v == null ? null : "[omitted]";
      continue;
    }
    out[k] = typeof v === "string" && v.length > 400 ? `${v.slice(0, 400)}…` : v;
  }
  return out;
}

function windowStatus(deadline: string | null, daysRemaining: number | null): PacketEventSection["window"]["status"] {
  const remaining =
    daysRemaining ??
    (deadline ? Math.floor((new Date(`${deadline}T23:59:59Z`).getTime() - Date.now()) / 86_400_000) : null);
  if (remaining == null) return "unknown";
  if (remaining < 0) return "expired";
  if (remaining <= 14) return "closing_soon";
  return "open";
}

function meta(row: Row): Record<string, unknown> {
  const m = row.metadata;
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
}

function metaEdges(m: Record<string, unknown>): PacketReferenceEdge[] {
  const raw = m.reference_edges;
  if (!Array.isArray(raw)) return [];
  const out: PacketReferenceEdge[] = [];
  for (const e of raw) {
    if (e && typeof e === "object") {
      const kind = str((e as Row).reference_kind);
      const value = str((e as Row).reference_value);
      if (kind && value) out.push({ reference_kind: kind, reference_value: value, edge_source: "metadata" });
    }
  }
  return out;
}

/** Merge metadata edges with materialized claim_reference_edges (7H pool anchor); dedupe by kind+value+type. */
function mergeReferenceEdges(
  metadataEdges: PacketReferenceEdge[],
  materializedRows: Array<Record<string, unknown>>,
): PacketReferenceEdge[] {
  const out: PacketReferenceEdge[] = [];
  const seen = new Set<string>();
  const push = (e: PacketReferenceEdge) => {
    const k = `${e.edge_type ?? ""}\u0000${e.reference_kind}\u0000${e.reference_value}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(e);
  };
  for (const row of materializedRows) {
    const kind = str(row.reference_kind) ?? str(row.edge_type) ?? "edge";
    const value = str(row.reference_value) ?? str(row.to_source_row_id);
    if (!value) continue;
    push({
      reference_kind: kind,
      reference_value: value,
      edge_source: "materialized",
      edge_type: str(row.edge_type),
      to_source_table: str(row.to_source_table),
      to_source_row_id: str(row.to_source_row_id),
      ambiguity_group_key: str(row.ambiguity_group_key),
      operator_review_status: str(row.operator_review_status),
    });
  }
  for (const e of metadataEdges) push(e);
  return out;
}

function photosFromReturnItem(row: Row | null): PacketPhoto[] {
  if (!row) return [];
  const raw = row.photo_evidence;
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((p): PacketPhoto | null => {
      if (typeof p === "string") {
        return { source: "return_item_photo_evidence", url: p, storage_path: null, mime_type: null, note: null };
      }
      if (p && typeof p === "object") {
        const o = p as Row;
        const url = str(o.url) ?? str(o.public_url);
        const path = str(o.storage_path) ?? str(o.path);
        if (!url && !path) return null;
        return {
          source: "return_item_photo_evidence",
          url,
          storage_path: path,
          mime_type: str(o.mime_type),
          note: str(o.note),
        };
      }
      return null;
    })
    .filter((p): p is PacketPhoto => p !== null);
}

async function buildEventSection(
  client: SupabaseClient,
  organizationId: string,
  candidate: Row,
  sectionIndex: number,
  materializedEdges: Array<Record<string, unknown>>,
): Promise<PacketEventSection> {
  const candidateId = String(candidate.id);
  const m = meta(candidate);
  const returnItemId = str(candidate.return_item_id);
  const packageId = str(candidate.package_id);
  const sourceTable = String(candidate.source_table ?? "");
  const sourceRowId = String(candidate.source_row_id ?? "");

  // Parallel context fetches.
  const [evidenceRes, returnItemRes, packageRes, auditRes, sourceRes] = await Promise.all([
    client
      .from("claim_evidence")
      .select("public_url, storage_path, mime_type, operator_note, claim_candidate_id, return_item_id")
      .eq("organization_id", organizationId)
      .or(
        [
          `claim_candidate_id.eq.${candidateId}`,
          returnItemId ? `return_item_id.eq.${returnItemId}` : null,
        ]
          .filter(Boolean)
          .join(","),
      )
      .limit(40),
    returnItemId
      ? client
          .from("return_items")
          .select("id, item_name, notes, photo_evidence, created_at, scanned_quantity")
          .eq("id", returnItemId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    packageId
      ? client
          .from("packages")
          .select("id, package_code, tracking_number")
          .eq("id", packageId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    packageId
      ? client
          .from("package_audit_log")
          .select("action, field, new_value, actor, created_at")
          .eq("package_id", packageId)
          .order("created_at", { ascending: false })
          .limit(10)
      : Promise.resolve({ data: [] }),
    SNAPSHOT_TABLES.has(sourceTable) && sourceRowId
      ? client.from(sourceTable).select("*").eq("id", sourceRowId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const returnItem = (returnItemRes.data as Row | null) ?? null;
  const pkg = (packageRes.data as Row | null) ?? null;
  const sourceRow = (sourceRes.data as Row | null) ?? null;

  const photos: PacketPhoto[] = [
    ...(((evidenceRes.data ?? []) as Row[]).map(
      (e): PacketPhoto => ({
        source: "claim_evidence",
        url: str(e.public_url),
        storage_path: str(e.storage_path),
        mime_type: str(e.mime_type),
        note: str(e.operator_note),
      }),
    ) ?? []),
    ...photosFromReturnItem(returnItem),
  ];

  const timeline: PacketTimelineEntry[] = [];
  if (returnItem?.created_at) {
    timeline.push({
      at: String(returnItem.created_at),
      kind: "scan_recorded",
      label: "Unit scanned",
      detail: str(returnItem.item_name),
    });
  }
  timeline.push({
    at: str(candidate.created_at),
    kind: "candidate_detected",
    label: "Claim candidate detected",
    detail: `${candidate.source_kind} / ${candidate.claim_family}`,
  });
  if (candidate.updated_at && candidate.updated_at !== candidate.created_at) {
    timeline.push({
      at: str(candidate.updated_at),
      kind: "candidate_updated",
      label: "Candidate refreshed",
      detail: str(m.live_trigger) ? `trigger: ${String(m.live_trigger)}` : null,
    });
  }
  if (candidate.quarantined_at) {
    timeline.push({
      at: str(candidate.quarantined_at),
      kind: "quarantined",
      label: "Quarantined",
      detail: str(candidate.quarantine_reason),
    });
  }
  if (candidate.rejected_at) {
    timeline.push({
      at: str(candidate.rejected_at),
      kind: "rejected",
      label: "Rejected",
      detail: str(candidate.rejected_reason),
    });
  }
  for (const a of ((auditRes.data ?? []) as Row[]).slice(0, 6)) {
    timeline.push({
      at: str(a.created_at),
      kind: "package_audit",
      label: `Box: ${String(a.action ?? "audit")}`,
      detail: str(a.actor),
    });
  }
  timeline.sort((x, y) => String(x.at ?? "").localeCompare(String(y.at ?? "")));

  return {
    anchor: `event-${sectionIndex + 1}-${candidateId.slice(0, 8)}`,
    candidate_id: candidateId,
    claim_family: String(candidate.claim_family ?? ""),
    claim_reason: String(candidate.claim_reason ?? ""),
    source_kind: String(candidate.source_kind ?? ""),
    physical_event: str(m.physical_event),
    product: {
      resolved_product_id: str(candidate.resolved_product_id),
      sku: str(candidate.sku),
      fnsku: str(candidate.fnsku),
      asin: str(candidate.asin),
      item_name: str(returnItem?.item_name),
    },
    reference: {
      reference_id: str(candidate.reference_id),
      reference_type: str(candidate.reference_type),
    },
    quantities: {
      expected: num(candidate.expected_quantity),
      actual: num(candidate.actual_quantity),
      delta: num(candidate.delta_quantity),
    },
    money: {
      recovery_value: num(candidate.recovery_value),
      cogs_unit: num(candidate.cogs_unit),
      expected_amount: num(candidate.expected_amount),
      currency: str(candidate.currency) ?? "USD",
    },
    window: {
      event_date: str(candidate.event_date),
      dispute_deadline: str(candidate.dispute_deadline),
      days_remaining: num(candidate.days_remaining),
      status: windowStatus(str(candidate.dispute_deadline), num(candidate.days_remaining)),
    },
    shipment_context: {
      shipment_scope_key: str(candidate.shipment_scope_key) ?? str(m.shipment_scope_key),
      pallet_id: str(candidate.pallet_id),
      package_id: packageId,
      package_code: str(pkg?.package_code),
      tracking_number: str(pkg?.tracking_number),
    },
    scan_notes: str(returnItem?.notes),
    timeline,
    photos,
    source_report: {
      source_table: sourceTable,
      source_row_id: sourceRowId,
      snapshot: sourceRow ? sanitizeSnapshot(sourceRow) : null,
    },
    reference_graph: mergeReferenceEdges(metaEdges(m), materializedEdges),
    orbit_evidence_summary: str(m.evidence_summary),
  };
}

function productLabel(s: PacketEventSection): string {
  return (
    s.product.item_name ??
    s.product.fnsku ??
    s.product.sku ??
    s.product.asin ??
    s.product.resolved_product_id ??
    "unknown product"
  );
}

export async function composeClaimEvidencePacket(
  client: SupabaseClient,
  args: {
    organizationId: string;
    candidateIds: string[];
    title?: string | null;
    /** Operator confirmed mixed-grouping warnings. */
    confirmMixed?: boolean;
  },
): Promise<ComposePacketResult> {
  const organizationId = args.organizationId.trim();
  const ids = [...new Set(args.candidateIds.map((x) => x.trim()).filter(Boolean))];
  if (!ids.length) return { ok: false, error: "At least one candidate id is required." };
  if (ids.length > 50) return { ok: false, error: "Packet limited to 50 candidates." };

  const { data, error } = await client
    .from("claim_candidates")
    .select("*")
    .eq("organization_id", organizationId)
    .in("id", ids);
  if (error) return { ok: false, error: error.message };
  const candidates = (data ?? []) as Row[];
  if (candidates.length !== ids.length) {
    return { ok: false, error: `Found ${candidates.length}/${ids.length} candidates in this organization.` };
  }

  // Manual grouping policy (allow single / grouped; warn mixed; override gate).
  const policy = await loadClaimCandidateIntakePolicy(client, organizationId);
  const { data: orgSettings } = await client
    .from("organization_settings")
    .select("claim_policy")
    .eq("organization_id", organizationId)
    .maybeSingle();
  const claimPolicy = ((orgSettings as Row | null)?.claim_policy ?? {}) as Row;
  const allowManualOverride = claimPolicy.allow_manual_override === true;

  const distinct = (vals: Array<string | null>) => new Set(vals.filter((v): v is string => !!v)).size;
  const products = distinct(
    candidates.map((c) => str(c.resolved_product_id) ?? str(c.fnsku) ?? str(c.sku) ?? str(c.asin)),
  );
  const problemTypes = distinct(
    candidates.map((c) => str(meta(c).physical_event as unknown) ?? str(c.claim_family)),
  );
  const referenceTypes = distinct(candidates.map((c) => str(c.reference_type)));

  const grouping = evaluateManualGroupingPolicy(policy.manual_grouping, {
    itemCount: candidates.length,
    distinctProductCount: products,
    distinctProblemTypeCount: problemTypes,
    distinctReferenceTypeCount: referenceTypes,
  });

  if (!grouping.allowed && !(args.confirmMixed && allowManualOverride)) {
    return {
      ok: false,
      error:
        grouping.blocked_reason === "single_not_allowed"
          ? "Single-candidate claims are disabled by policy."
          : "Grouped claims are disabled by policy.",
      blocked_reason: grouping.blocked_reason,
    };
  }
  const requiresConfirmation = grouping.warnings.length > 0 && args.confirmMixed !== true;

  // Materialized pool edges (7H) — single fetch for all candidates; degrades to empty pre-migration.
  const materializedByCandidate = await loadMaterializedCandidateEdges(client, organizationId, ids);

  // Event sections.
  const events: PacketEventSection[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i]!;
    events.push(
      await buildEventSection(
        client,
        organizationId,
        candidate,
        i,
        materializedByCandidate.get(String(candidate.id)) ?? [],
      ),
    );
  }

  // Warnings.
  const warnings: PacketWarning[] = grouping.warnings.map((w) => ({
    code: w,
    message: MANUAL_GROUPING_WARNING_LABELS[w],
    candidate_ids: ids,
  }));
  const expired = events.filter((e) => e.window.status === "expired");
  if (expired.length) {
    warnings.push({
      code: "expired_claim_window",
      message: `${expired.length} candidate(s) are past their dispute deadline.`,
      candidate_ids: expired.map((e) => e.candidate_id),
    });
  }
  const noEvidence = events.filter((e) => e.photos.length === 0);
  if (noEvidence.length) {
    warnings.push({
      code: "missing_evidence",
      message: `${noEvidence.length} candidate(s) have no photo/file evidence attached.`,
      candidate_ids: noEvidence.map((e) => e.candidate_id),
    });
  }
  const noProduct = events.filter((e) => !e.product.resolved_product_id);
  if (noProduct.length) {
    warnings.push({
      code: "missing_product_link",
      message: `${noProduct.length} candidate(s) have no resolved product link.`,
      candidate_ids: noProduct.map((e) => e.candidate_id),
    });
  }

  const lines: PacketIndexLine[] = events.map((e) => ({
    anchor: e.anchor,
    candidate_id: e.candidate_id,
    claim_family: e.claim_family,
    problem_type: e.physical_event ?? e.claim_reason,
    source_kind: e.source_kind,
    product_label: productLabel(e),
    sku: e.product.sku,
    fnsku: e.product.fnsku,
    asin: e.product.asin,
    reference_id: e.reference.reference_id,
    reference_type: e.reference.reference_type,
    units: e.quantities.expected ?? e.quantities.actual,
    recovery_value: e.money.recovery_value,
    window_status: e.window.status,
  }));

  const families = [...new Set(events.map((e) => e.claim_family))];
  const packet: ClaimEvidencePacket = {
    packet_id: crypto.randomUUID(),
    composed_at: new Date().toISOString(),
    organization_id: organizationId,
    title:
      str(args.title) ??
      (candidates.length === 1
        ? `Claim evidence — ${productLabel(events[0]!)} (${families[0]})`
        : `Grouped claim evidence — ${candidates.length} events (${families.join(", ")})`),
    grouped: candidates.length > 1,
    index: {
      claim_families: families,
      total_units: lines.reduce((s, l) => s + (l.units ?? 0), 0),
      total_recovery_value:
        Math.round(lines.reduce((s, l) => s + (l.recovery_value ?? 0), 0) * 100) / 100,
      currency: events[0]?.money.currency ?? "USD",
      lines,
    },
    events,
    warnings,
    grouping: {
      allowed: true,
      blocked_reason: grouping.allowed ? null : grouping.blocked_reason,
      requires_confirmation: requiresConfirmation,
      override_used: !grouping.allowed && args.confirmMixed === true && allowManualOverride,
    },
  };

  return { ok: true, packet };
}
