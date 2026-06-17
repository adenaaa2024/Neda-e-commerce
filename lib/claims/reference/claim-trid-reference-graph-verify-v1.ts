/**
 * PHASE-CLAIM-TRID-REFERENCE-GRAPH-FINAL-VERIFY-V1
 * Read-only TRID/reference graph verification for trusted pilot cases.
 */
import type { ClaimCaseReviewRow } from "../pilot/claim-case-review-readmodel";
import type { ClaimFilingPacketPreviewV1 } from "../filing/claim-filing-packet-preview-v1";
import { TRID_REFERENCE_TYPES } from "../contracts/claim-grouping-filters-manual-batch-contract-v1";

export const TRID_REFERENCE_GRAPH_VERIFY_V1_VERSION = "claim-trid-reference-graph-verify-v1" as const;

const TRID_KINDS = new Set<string>(TRID_REFERENCE_TYPES);

export type CandidateSourceRow = {
  id: string;
  source_kind: string | null;
  source_table: string | null;
  source_row_id: string | null;
  source_event_key: string | null;
  metadata: Record<string, unknown>;
};

export type ReferencePointer = {
  kind: string;
  value: string;
  source: string;
};

export type CaseReferenceGraphReport = {
  claim_case_id: string;
  claim_line_id: string | null;
  claim_candidate_id: string | null;
  family_key_v3: string | null;
  source_event_key: string | null;
  source_event_date: string | null;
  source_kind: string | null;
  source_table: string | null;
  source_row_id: string | null;
  tracking_reference: string | null;
  trid_reference: string | null;
  has_trid_edge: boolean;
  has_tracking_reference: boolean;
  has_expected_package_pointer: boolean;
  has_removal_order_pointer: boolean;
  has_removal_shipment_pointer: boolean;
  reference_edge_count_readmodel: number;
  reference_edge_count_preview: number;
  source_edge_count_preview: number;
  reference_edge_count_snapshot: number;
  reference_pointers: ReferencePointer[];
  warnings: string[];
  blockers: string[];
  blocked_for_manual_filing: boolean;
  export_json_reference_match: boolean;
  export_html_reference_match: boolean;
  export_pdf_present: boolean;
  layer_mismatch: boolean;
};

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function metaRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function edgeKey(kind: string | null, value: string | null): string {
  return `${str(kind).toLowerCase()}\u0000${str(value)}`;
}

function extractSnapshotReferenceEdges(
  snapshot: Record<string, unknown> | null,
): ReferencePointer[] {
  if (!snapshot) return [];
  const out: ReferencePointer[] = [];
  const metaEdges = snapshot.reference_edges;
  if (Array.isArray(metaEdges)) {
    for (const e of metaEdges) {
      const o = metaRecord(e);
      const kind = str(o.reference_kind) || str(o.edge_type) || "edge";
      const value = str(o.reference_value);
      if (value) out.push({ kind, value, source: "evidence_snapshot.reference_edges" });
    }
  }
  const pointers = snapshot.evidence_pointers;
  if (Array.isArray(pointers)) {
    for (const p of pointers) {
      const o = metaRecord(p);
      const table = str(o.table) || str(o.source_table);
      const rowId = str(o.row_id) || str(o.source_row_id);
      if (table && rowId) {
        out.push({ kind: table, value: rowId, source: "evidence_snapshot.evidence_pointers" });
      }
    }
  }
  const sourceEv = metaRecord(snapshot.source_evidence ?? snapshot.source_report);
  for (const key of ["expected_packages", "amazon_removals", "amazon_removal_shipments"]) {
    const ptr = sourceEv[key];
    if (ptr && typeof ptr === "object") {
      const o = metaRecord(ptr);
      const rowId = str(o.id) || str(o.source_row_id) || str(o.row_id);
      if (rowId) out.push({ kind: key, value: rowId, source: `evidence_snapshot.${key}` });
    } else if (typeof ptr === "string" && ptr) {
      out.push({ kind: key, value: ptr, source: `evidence_snapshot.${key}` });
    }
  }
  if (snapshot.expected_packages) {
    const o = metaRecord(snapshot.expected_packages);
    const id = str(o.id) || str(o.source_row_id);
    if (id) out.push({ kind: "expected_packages", value: id, source: "evidence_snapshot.expected_packages" });
  }
  return out;
}

function extractReadmodelPointers(row: ClaimCaseReviewRow): ReferencePointer[] {
  return row.reference_edges.map((e) => ({
    kind: str(e.reference_kind) || str(e.edge_type) || "edge",
    value: str(e.reference_value),
    source: "claim_reference_edges",
  }));
}

function extractPreviewPointers(preview: ClaimFilingPacketPreviewV1): ReferencePointer[] {
  const out: ReferencePointer[] = [];
  for (const e of preview.reference_edges) {
    out.push({
      kind: str(e.reference_kind) || str(e.edge_type) || "edge",
      value: str(e.reference_value),
      source: "filing_packet_preview.reference_edges",
    });
  }
  for (const e of preview.source_edges) {
    const o = metaRecord(e);
    const table = str(o.table) || str(o.source_table) || str(o.kind);
    const rowId = str(o.row_id) || str(o.source_row_id);
    if (table && rowId) {
      out.push({ kind: table, value: rowId, source: "filing_packet_preview.source_edges" });
    }
  }
  return out;
}

function isTridKind(kind: string): boolean {
  const k = kind.toLowerCase();
  return TRID_KINDS.has(k) || k.includes("trid");
}

function isTrackingKind(kind: string): boolean {
  const k = kind.toLowerCase();
  return k.includes("tracking") || k === "tracking_number" || k === "shipment_id";
}

export function verifyCaseReferenceGraph(args: {
  row: ClaimCaseReviewRow;
  preview: ClaimFilingPacketPreviewV1;
  candidate: CandidateSourceRow | null;
  exportedJsonPreview: ClaimFilingPacketPreviewV1 | null;
  exportedHtml: string | null;
  exportedPdfExists: boolean;
}): CaseReferenceGraphReport {
  const line = args.row.lines[0] ?? null;
  const snapshot = args.row.evidence_packet_snapshot;
  const snapPointers = extractSnapshotReferenceEdges(snapshot);
  const readPointers = extractReadmodelPointers(args.row);
  const previewPointers = extractPreviewPointers(args.preview);

  const allPointers = [...readPointers, ...snapPointers, ...previewPointers];
  const uniqueKeys = new Set(allPointers.map((p) => edgeKey(p.kind, p.value)));

  const warnings: string[] = [];
  const blockers: string[] = [];

  const trackingFromEvent =
    args.row.family_key_v3 === "removal_shipment_missing" && str(args.row.source_event_key)
      ? str(args.row.source_event_key)
      : null;

  let tridRef: string | null = null;
  for (const p of allPointers) {
    if (isTridKind(p.kind)) {
      tridRef = p.value;
      break;
    }
  }

  let trackingRef: string | null = trackingFromEvent;
  for (const p of allPointers) {
    if (isTrackingKind(p.kind)) {
      trackingRef = p.value;
      break;
    }
  }

  const hasExpectedPackage = allPointers.some(
    (p) => p.kind.includes("expected_package") || p.source.includes("expected_packages"),
  );
  const hasRemovalOrder = allPointers.some(
    (p) =>
      p.kind.includes("removal_order") ||
      p.kind === "amazon_removals" ||
      args.row.family_key_v3 === "removal_order_discrepancy",
  );
  const hasRemovalShipment = allPointers.some(
    (p) =>
      p.kind.includes("removal_shipment") ||
      p.kind === "amazon_removal_shipments" ||
      args.row.family_key_v3 === "removal_shipment_missing",
  );

  const hasTridEdge = tridRef != null;
  if (!hasTridEdge && (trackingRef || hasRemovalOrder || hasRemovalShipment)) {
    warnings.push("missing_trid_warning");
  }
  if (!hasTridEdge && str(args.row.source_event_key) && args.row.family_key_v3 === "removal_order_discrepancy") {
    warnings.push("missing_trid_warning");
  }

  const hasAnyReferenceEdge =
    readPointers.length > 0 || snapPointers.length > 0 || previewPointers.length > 0;

  const hasCandidateSource =
    !!str(args.candidate?.source_table) && !!str(args.candidate?.source_row_id);

  const hasSourceEvent = !!str(args.row.source_event_key);

  if (!hasAnyReferenceEdge && !hasCandidateSource && !hasSourceEvent) {
    blockers.push("no_source_reference_edge");
  }

  if (str(args.preview.source_event_key) !== str(args.row.source_event_key)) {
    blockers.push("mismatch_source_event_key");
  }
  if (str(args.preview.claim_case_id) !== str(args.row.id)) {
    blockers.push("mismatch_claim_case_id");
  }
  if (line && str(previewPointers.length ? args.preview.line_summary.claim_line_ids[0] : line.id) !== str(line.id)) {
    if (args.preview.line_summary.claim_line_ids[0] && line.id !== args.preview.line_summary.claim_line_ids[0]) {
      blockers.push("mismatch_claim_line_id");
    }
  }

  const readKeys = new Set(readPointers.map((p) => edgeKey(p.kind, p.value)));
  const previewKeys = new Set(previewPointers.map((p) => edgeKey(p.kind, p.value)));
  let layerMismatch = false;
  if (readPointers.length > 0 && previewPointers.length > 0) {
    for (const k of readKeys) {
      if (!previewKeys.has(k)) {
        layerMismatch = true;
        blockers.push("mismatch_readmodel_vs_preview_edges");
        break;
      }
    }
  }

  let exportJsonMatch = true;
  if (args.exportedJsonPreview) {
    const expKeys = new Set(
      extractPreviewPointers(args.exportedJsonPreview).map((p) => edgeKey(p.kind, p.value)),
    );
    const prevKeys = new Set(previewPointers.map((p) => edgeKey(p.kind, p.value)));
    if (str(args.exportedJsonPreview.source_event_key) !== str(args.preview.source_event_key)) {
      exportJsonMatch = false;
      blockers.push("mismatch_export_json_source_event_key");
    }
    if (prevKeys.size !== expKeys.size) {
      for (const k of prevKeys) {
        if (!expKeys.has(k)) {
          exportJsonMatch = false;
          blockers.push("mismatch_preview_vs_export_json_edges");
          break;
        }
      }
    }
  } else {
    exportJsonMatch = false;
    warnings.push("export_json_missing");
  }

  let exportHtmlMatch = true;
  if (args.exportedHtml) {
    const mustAppear = [
      str(args.row.source_event_key),
      str(args.row.id),
      str(line?.claim_candidate_id),
    ].filter(Boolean);
    for (const token of mustAppear) {
      if (!args.exportedHtml.includes(token)) {
        exportHtmlMatch = false;
        warnings.push("export_html_missing_token");
        break;
      }
    }
    for (const p of previewPointers.slice(0, 5)) {
      if (p.value && !args.exportedHtml.includes(p.value)) {
        exportHtmlMatch = false;
        warnings.push("export_html_missing_reference_value");
        break;
      }
    }
  } else {
    exportHtmlMatch = false;
    warnings.push("export_html_missing");
  }

  if (args.candidate) {
    if (str(args.candidate.source_event_key) && str(args.candidate.source_event_key) !== str(args.row.source_event_key)) {
      blockers.push("mismatch_candidate_source_event_key");
    }
  }

  const blocked = blockers.length > 0;

  return {
    claim_case_id: args.row.id,
    claim_line_id: line?.id ?? null,
    claim_candidate_id: line?.claim_candidate_id ?? null,
    family_key_v3: args.row.family_key_v3,
    source_event_key: args.row.source_event_key,
    source_event_date: args.row.source_event_date,
    source_kind: args.candidate?.source_kind ?? (str(snapshot?.source_kind) || null),
    source_table: args.candidate?.source_table ?? null,
    source_row_id: args.candidate?.source_row_id ?? null,
    tracking_reference: trackingRef,
    trid_reference: tridRef,
    has_trid_edge: hasTridEdge,
    has_tracking_reference: !!trackingRef,
    has_expected_package_pointer: hasExpectedPackage || args.candidate?.source_table === "expected_packages",
    has_removal_order_pointer:
      hasRemovalOrder || args.candidate?.source_table === "amazon_removals",
    has_removal_shipment_pointer:
      hasRemovalShipment || args.candidate?.source_table === "amazon_removal_shipments",
    reference_edge_count_readmodel: readPointers.length,
    reference_edge_count_preview: args.preview.reference_edges.length,
    source_edge_count_preview: args.preview.source_edges.length,
    reference_edge_count_snapshot: snapPointers.length,
    reference_pointers: [...uniqueKeys].map((k) => {
      const [kind, value] = k.split("\u0000");
      const found = allPointers.find((p) => edgeKey(p.kind, p.value) === k);
      return { kind, value, source: found?.source ?? "merged" };
    }),
    warnings: [...new Set(warnings)],
    blockers: [...new Set(blockers)],
    blocked_for_manual_filing: blocked,
    export_json_reference_match: exportJsonMatch,
    export_html_reference_match: exportHtmlMatch,
    export_pdf_present: args.exportedPdfExists,
    layer_mismatch: layerMismatch,
  };
}

export function summarizeReferenceGraphReports(reports: CaseReferenceGraphReport[]): {
  trid_coverage_count: number;
  trid_missing_count: number;
  reference_edge_coverage_count: number;
  source_edge_coverage_count: number;
  expected_package_reference_count: number;
  removal_order_reference_count: number;
  removal_shipment_reference_count: number;
  tracking_reference_count: number;
  mismatch_count: number;
  blocked_case_count: number;
  warning_counts: Record<string, number>;
  by_family: Record<string, number>;
} {
  const warning_counts: Record<string, number> = {};
  const by_family: Record<string, number> = {};
  let tridCov = 0;
  let tridMiss = 0;
  let refEdgeCov = 0;
  let srcEdgeCov = 0;
  let ep = 0;
  let ro = 0;
  let rs = 0;
  let track = 0;
  let mismatch = 0;
  let blocked = 0;

  for (const r of reports) {
    const fam = r.family_key_v3 ?? "unknown";
    by_family[fam] = (by_family[fam] ?? 0) + 1;
    if (r.has_trid_edge) tridCov += 1;
    else tridMiss += 1;
    if (r.reference_edge_count_readmodel > 0 || r.reference_edge_count_snapshot > 0 || r.reference_edge_count_preview > 0) {
      refEdgeCov += 1;
    }
    if (r.source_edge_count_preview > 0) srcEdgeCov += 1;
    if (r.has_expected_package_pointer) ep += 1;
    if (r.has_removal_order_pointer) ro += 1;
    if (r.has_removal_shipment_pointer) rs += 1;
    if (r.has_tracking_reference) track += 1;
    if (r.layer_mismatch || !r.export_json_reference_match) mismatch += 1;
    if (r.blocked_for_manual_filing) blocked += 1;
    for (const w of r.warnings) warning_counts[w] = (warning_counts[w] ?? 0) + 1;
    for (const b of r.blockers) warning_counts[`blocker:${b}`] = (warning_counts[`blocker:${b}`] ?? 0) + 1;
  }

  return {
    trid_coverage_count: tridCov,
    trid_missing_count: tridMiss,
    reference_edge_coverage_count: refEdgeCov,
    source_edge_coverage_count: srcEdgeCov,
    expected_package_reference_count: ep,
    removal_order_reference_count: ro,
    removal_shipment_reference_count: rs,
    tracking_reference_count: track,
    mismatch_count: mismatch,
    blocked_case_count: blocked,
    warning_counts,
    by_family,
  };
}
