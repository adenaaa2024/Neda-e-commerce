/**
 * PHASE-CLAIM-TRID-REFERENCE-GRAPH-REVERIFY-AFTER-7H-V1
 * Post-7H read-only reference graph re-verification gates.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { ClaimCaseReviewRow } from "../pilot/claim-case-review-readmodel";
import type { ClaimFilingPacketPreviewV1 } from "../filing/claim-filing-packet-preview-v1";
import {
  buildHandoffReferenceGraph,
  type HandoffReferenceGraphLine,
} from "../submission/claim-manual-filing-handoff-ui-contract";
import {
  type CaseReferenceGraphReport,
  type CandidateSourceRow,
  verifyCaseReferenceGraph,
} from "./claim-trid-reference-graph-verify-v1";

export const TRID_REFERENCE_GRAPH_REVERIFY_AFTER_7H_V1_VERSION =
  "claim-trid-reference-graph-reverify-after-7h-v1" as const;

export const PHASE_7H_EVIDENCE_GLOB_HINTS = [
  ".cursor/audit-reports/phase7h-claim-reference-edge-materialization-pilot-original-execute-v1",
  ".cursor/audit-reports/phase7h-claim-reference-edge-materialization-pilot-v1",
  ".cursor/audit-reports/phase-7h-claim-reference-edge-materialization-pilot-v1",
  ".cursor/audit-reports/phase-7h-claim-reference-edge-materialization-staging",
] as const;

export const TRID_REFERENCE_GRAPH_REVERIFY_EXPORT_REGEN_AFTER_7H_V1_VERSION =
  "claim-trid-reference-graph-reverify-export-regen-after-7h-v1" as const;

export type Post7hCaseReferenceReport = CaseReferenceGraphReport & {
  has_materialized_reference_edges: boolean;
  has_source_edge_or_equivalent: boolean;
  handoff_reference_line_count: number;
  handoff_matches_preview: boolean;
  export_stale_needs_regeneration: boolean;
  filing_packet_preview_edge_count: number;
};

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function edgeKeysFromPreview(preview: ClaimFilingPacketPreviewV1): Set<string> {
  const keys = new Set<string>();
  for (const e of preview.reference_edges) {
    keys.add(`${str(e.reference_kind) || str(e.edge_type)}\u0000${str(e.reference_value)}`);
  }
  for (const e of preview.source_edges) {
    const o = e as Record<string, unknown>;
    const table = str(o.table) || str(o.source_table);
    const rowId = str(o.row_id) || str(o.source_row_id);
    if (table && rowId) keys.add(`${table}\u0000${rowId}`);
  }
  return keys;
}

function edgeKeysFromHandoff(lines: HandoffReferenceGraphLine[]): Set<string> {
  return new Set(lines.map((l) => `${l.kind}\u0000${l.value}`));
}

export function verifyCaseReferenceGraphPost7h(args: {
  row: ClaimCaseReviewRow;
  preview: ClaimFilingPacketPreviewV1;
  candidate: CandidateSourceRow | null;
  exportedJsonPreview: ClaimFilingPacketPreviewV1 | null;
  exportedHtml: string | null;
  exportedPdfExists: boolean;
}): Post7hCaseReferenceReport {
  const base = verifyCaseReferenceGraph(args);

  const hasMaterialized = base.reference_edge_count_readmodel > 0;
  const hasSourceEquivalent =
    base.source_edge_count_preview > 0 ||
    (!!str(args.candidate?.source_table) && !!str(args.candidate?.source_row_id));

  const warnings = [...base.warnings];
  const blockers = base.blockers.filter(
    (b) => b !== "no_source_reference_edge" && !b.startsWith("mismatch_export"),
  );

  if (!hasMaterialized) {
    blockers.push("missing_materialized_reference_edges");
  }
  if (!str(base.claim_line_id)) blockers.push("missing_claim_line_id");
  if (!str(base.claim_candidate_id)) blockers.push("missing_claim_candidate_id");
  if (!base.has_expected_package_pointer) blockers.push("missing_expected_package_reference");
  if (!str(base.source_event_key)) blockers.push("missing_source_event_key");
  if (!str(base.source_event_date)) blockers.push("missing_source_event_date");
  if (!str(base.source_table) || !str(base.source_row_id)) {
    blockers.push("missing_source_table_row");
  }

  if (hasMaterialized && base.reference_edge_count_preview === 0) {
    blockers.push("filing_packet_preview_missing_reference_edges");
  }

  if (hasMaterialized && base.reference_edge_count_preview > 0) {
    const readKeys = new Set(
      args.row.reference_edges.map(
        (e) => `${str(e.reference_kind) || str(e.edge_type)}\u0000${str(e.reference_value)}`,
      ),
    );
    const previewKeys = new Set(
      args.preview.reference_edges.map(
        (e) => `${str(e.reference_kind) || str(e.edge_type)}\u0000${str(e.reference_value)}`,
      ),
    );
    for (const k of readKeys) {
      if (!previewKeys.has(k)) {
        blockers.push("mismatch_readmodel_vs_preview_edges");
        break;
      }
    }
  }

  const handoffGraph = buildHandoffReferenceGraph(args.row, args.preview);
  const previewKeys = edgeKeysFromPreview(args.preview);
  const handoffKeys = edgeKeysFromHandoff(handoffGraph.lines);
  let handoffMatchesPreview = true;
  if (previewKeys.size > 0) {
    for (const k of previewKeys) {
      if (!handoffKeys.has(k) && !handoffGraph.lines.some((l) => `${l.kind}\u0000${l.value}` === k)) {
        handoffMatchesPreview = false;
        break;
      }
    }
  }
  if (!handoffMatchesPreview) {
    blockers.push("mismatch_handoff_vs_preview");
  }

  let exportStale = false;
  if (args.exportedJsonPreview) {
    const expEdgeCount = args.exportedJsonPreview.reference_edges.length;
    if (base.reference_edge_count_preview > 0 && expEdgeCount < base.reference_edge_count_preview) {
      exportStale = true;
      warnings.push("export_json_stale_needs_regeneration");
    }
  } else {
    exportStale = base.reference_edge_count_preview > 0;
    warnings.push("export_json_stale_needs_regeneration");
  }

  const tridOnlyWarnings = warnings.includes("missing_trid_warning");
  const blocked = blockers.length > 0;
  void tridOnlyWarnings;

  return {
    ...base,
    warnings: [...new Set(warnings)],
    blockers: [...new Set(blockers)],
    blocked_for_manual_filing: blocked,
    has_materialized_reference_edges: hasMaterialized,
    has_source_edge_or_equivalent: hasSourceEquivalent,
    handoff_reference_line_count: handoffGraph.lines.length,
    handoff_matches_preview: handoffMatchesPreview,
    export_stale_needs_regeneration: exportStale,
    filing_packet_preview_edge_count: base.reference_edge_count_preview,
    layer_mismatch: blockers.some((b) => b.includes("mismatch")),
  };
}

export function summarizePost7hReports(reports: Post7hCaseReferenceReport[]): {
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
  materialized_reference_edge_count: number;
  export_stale_count: number;
  handoff_display_pass_count: number;
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
  let materialized = 0;
  let exportStale = 0;
  let handoffPass = 0;

  for (const r of reports) {
    const fam = r.family_key_v3 ?? "unknown";
    by_family[fam] = (by_family[fam] ?? 0) + 1;
    if (r.has_trid_edge) tridCov += 1;
    else tridMiss += 1;
    if (r.has_materialized_reference_edges) {
      refEdgeCov += 1;
      materialized += 1;
    }
    if (r.has_source_edge_or_equivalent) srcEdgeCov += 1;
    if (r.has_expected_package_pointer) ep += 1;
    if (r.has_removal_order_pointer) ro += 1;
    if (r.has_removal_shipment_pointer) rs += 1;
    if (r.has_tracking_reference) track += 1;
    if (r.layer_mismatch || !r.handoff_matches_preview) mismatch += 1;
    if (r.blocked_for_manual_filing) blocked += 1;
    if (r.export_stale_needs_regeneration) exportStale += 1;
    if (r.handoff_matches_preview) handoffPass += 1;
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
    materialized_reference_edge_count: materialized,
    export_stale_count: exportStale,
    handoff_display_pass_count: handoffPass,
  };
}

export function findPhase7hEvidence(
  cwd: string,
  fs: typeof import("node:fs"),
): {
  found: boolean;
  path: string | null;
  SAFE_REFERENCE_EDGES_MATERIALIZED: string;
} {
  for (const hint of PHASE_7H_EVIDENCE_GLOB_HINTS) {
    const base = path.join(cwd, hint);
    if (!fs.existsSync(base)) continue;
    const runs = fs
      .readdirSync(base)
      .filter((d) => fs.statSync(path.join(base, d)).isDirectory())
      .sort()
      .reverse();
    for (const run of runs) {
      const resultsPath = path.join(base, run, "results.json");
      if (!fs.existsSync(resultsPath)) continue;
      const data = JSON.parse(fs.readFileSync(resultsPath, "utf8")) as Record<string, unknown>;
      const safe = str(data.SAFE_REFERENCE_EDGES_MATERIALIZED);
      return {
        found: true,
        path: path.relative(cwd, resultsPath).replace(/\\/g, "/"),
        SAFE_REFERENCE_EDGES_MATERIALIZED: safe || "missing_key",
      };
    }
  }
  return { found: false, path: null, SAFE_REFERENCE_EDGES_MATERIALIZED: "missing" };
}

export function findPhase7hOriginalExecuteEvidence(
  cwd: string,
  fs: typeof import("node:fs"),
): {
  found: boolean;
  path: string | null;
  SAFE_REFERENCE_EDGES_MATERIALIZED: string;
  run_id: string | null;
} {
  const base = path.join(cwd, ".cursor/audit-reports/phase7h-claim-reference-edge-materialization-pilot-original-execute-v1");
  if (!fs.existsSync(base)) {
    return { found: false, path: null, SAFE_REFERENCE_EDGES_MATERIALIZED: "missing", run_id: null };
  }
  const runs = fs
    .readdirSync(base)
    .filter((d) => fs.statSync(path.join(base, d)).isDirectory())
    .sort()
    .reverse();
  for (const run of runs) {
    const resultsPath = path.join(base, run, "results.json");
    if (!fs.existsSync(resultsPath)) continue;
    const data = JSON.parse(fs.readFileSync(resultsPath, "utf8")) as Record<string, unknown>;
    const safe = str(data.SAFE_REFERENCE_EDGES_MATERIALIZED);
    return {
      found: true,
      path: path.relative(cwd, resultsPath).replace(/\\/g, "/"),
      SAFE_REFERENCE_EDGES_MATERIALIZED: safe || "missing_key",
      run_id: str(data.materialization_run_id || data.run_id) || run,
    };
  }
  return { found: false, path: null, SAFE_REFERENCE_EDGES_MATERIALIZED: "missing", run_id: null };
}

export function verifyRegeneratedExportReferences(args: {
  preview: ClaimFilingPacketPreviewV1;
  exportedJsonPath: string;
  exportedHtmlPath: string;
  exportedPdfPath: string | null;
}): {
  json_edge_count: number;
  preview_edge_count: number;
  json_matches_preview: boolean;
  html_includes_reference: boolean;
  pdf_present: boolean;
  pass: boolean;
} {
  const previewEdgeCount = args.preview.reference_edges.length;
  let jsonEdgeCount = 0;
  let jsonMatches = false;
  if (fs.existsSync(args.exportedJsonPath)) {
    const raw = JSON.parse(fs.readFileSync(args.exportedJsonPath, "utf8")) as Record<string, unknown>;
    const fp = raw.filing_packet_preview as ClaimFilingPacketPreviewV1 | undefined;
    jsonEdgeCount = fp?.reference_edges?.length ?? 0;
    jsonMatches = jsonEdgeCount === previewEdgeCount && previewEdgeCount > 0;
  }
  let htmlIncludes = false;
  if (fs.existsSync(args.exportedHtmlPath) && previewEdgeCount > 0) {
    const html = fs.readFileSync(args.exportedHtmlPath, "utf8");
    const sample = args.preview.reference_edges[0];
    const kind = str(sample?.reference_kind) || str(sample?.edge_type);
    const value = str(sample?.reference_value);
    htmlIncludes = (!!kind && html.includes(kind)) || (!!value && html.includes(value));
  }
  const pdfPresent = !!args.exportedPdfPath && fs.existsSync(args.exportedPdfPath);
  return {
    json_edge_count: jsonEdgeCount,
    preview_edge_count: previewEdgeCount,
    json_matches_preview: jsonMatches,
    html_includes_reference: htmlIncludes || previewEdgeCount === 0,
    pdf_present: pdfPresent,
    pass: jsonMatches && (htmlIncludes || previewEdgeCount === 0),
  };
}
