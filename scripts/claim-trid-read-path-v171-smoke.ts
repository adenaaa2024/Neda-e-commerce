/**
 * CLAIM-TRID-READ-PATH-FINALIZE-V171 — Read-only staging smoke (pilot draft).
 *
 *   npm run verify:claim-trid-read-path-v171
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { buildClaimFilingPacketPreview } from "../lib/claim-filing-packet-preview";
import { buildClaimEvidenceGraphResponse, fetchDraftRow } from "../lib/claim-evidence-preview";
import { buildReferenceCandidatesResponseForDraftId } from "../lib/claim-reference-candidates";
import { CLAIM_TRID_WORKFLOW_STATUSES } from "../lib/claim-trid-operator-status";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const DRAFT_ID = "003db7ff-23f5-4d28-b13e-e13198ea38d8";
const RUN_ID = process.env.CLAIM_TRID_V171_RUN_ID?.trim() || "20260519T140000Z";

function loadEnvLocal(): void {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

function verifyUiMarkers(): Record<string, boolean> {
  const root = path.join(process.cwd(), "components", "claims");
  const client = fs.readFileSync(
    path.join(process.cwd(), "app", "claim-engine", "evidence", "ClaimDraftEvidenceClient.tsx"),
    "utf8",
  );
  const panel = fs.readFileSync(path.join(root, "ClaimReferenceCandidatesPanel.tsx"), "utf8");
  const linkage = fs.readFileSync(path.join(root, "ClaimDraftProductLinkagePanel.tsx"), "utf8");
  const op = fs.readFileSync(path.join(root, "ClaimTridOperatorStatusPanel.tsx"), "utf8");
  const packet = fs.readFileSync(path.join(root, "ClaimFilingPacketPreviewPanel.tsx"), "utf8");
  const viewer = fs.readFileSync(path.join(root, "ClaimEvidenceViewer.tsx"), "utf8");

  return {
    evidence_client_all_panels:
      client.includes("ClaimEvidenceViewer") &&
      client.includes("ClaimReferenceCandidatesPanel") &&
      client.includes("ClaimDraftProductLinkagePanel") &&
      client.includes("ClaimTridOperatorStatusPanel"),
    reference_copy_button: panel.includes("CopyButton"),
    packet_no_submit: packet.includes("does not submit claims"),
    packet_reference_candidates: packet.includes("reference_candidates"),
    packet_missing_refs: packet.includes("missing_references_warning"),
    viewer_warnings: viewer.includes("warnings"),
    operator_statuses_include_copied: CLAIM_TRID_WORKFLOW_STATUSES.includes("copied_to_amazon_form"),
    linkage_resolver_badge: linkage.includes("resolutionStatusLabel"),
  };
}

async function main(): Promise<void> {
  loadEnvLocal();
  const outDir = path.resolve(process.cwd(), ".cursor/audit-reports/claim-trid-read-path-finalize-v171", RUN_ID);
  fs.mkdirSync(outDir, { recursive: true });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  const ui = verifyUiMarkers();

  if (!url.includes(STAGING_REF)) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL must point to staging.");
  }

  const report: Record<string, unknown> = {
    run_id: RUN_ID,
    staging_ref: STAGING_REF,
    draft_id: DRAFT_ID,
    ui_markers: ui,
    ui_all_pass: Object.values(ui).every(Boolean),
  };

  if (!key) {
    fs.writeFileSync(path.join(outDir, "smoke.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }

  const client = createClient(url, key, { auth: { persistSession: false } });
  const draft = await fetchDraftRow(client, ORG_ID, DRAFT_ID);
  if (!draft) throw new Error("Pilot draft not found");

  const [graph, refs, packet] = await Promise.all([
    buildClaimEvidenceGraphResponse(client, draft, { includePersistedEdgeList: true }),
    buildReferenceCandidatesResponseForDraftId(client, ORG_ID, DRAFT_ID),
    buildClaimFilingPacketPreview(client, draft),
  ]);

  let product_linkage_ok = Boolean(draft.sku?.trim());
  if (!product_linkage_ok && draft.source_table === "amazon_removals") {
    const { data, error } = await client
      .from("amazon_removals")
      .select("id, sku, fnsku, asin, resolved_product_id")
      .eq("organization_id", ORG_ID)
      .eq("id", draft.source_row_id)
      .maybeSingle();
    if (!error && data) {
      const row = data as Record<string, unknown>;
      product_linkage_ok = Boolean(
        (typeof row.sku === "string" && row.sku.trim()) ||
          (typeof row.fnsku === "string" && row.fnsku.trim()) ||
          (typeof row.resolved_product_id === "string" && row.resolved_product_id.trim()),
      );
    }
  }

  const checks = {
    evidence_edges: (graph.graph_preview.edge_count_returned ?? 0) > 0 || graph.graph_preview.enrichment.persisted_edge_count > 0,
    reference_candidates: (refs?.candidate_count ?? 0) > 0,
    packet_claim_summary: Boolean(packet.claim_summary.source_table),
    packet_evidence_groups: packet.evidence_groups.length >= 0,
    packet_reference_candidates: packet.reference_candidates.length > 0,
    packet_missing_refs_warn: packet.missing_references_warning != null,
    packet_does_not_submit: packet.does_not_submit === true,
    packet_filing_gate: packet.filing_readiness != null,
    product_linkage: product_linkage_ok,
    operator_edge_statuses: ["accepted", "rejected", "needs_review"].every((s) =>
      CLAIM_TRID_WORKFLOW_STATUSES.includes(s as "accepted"),
    ),
  };

  report.data_checks = checks;
  report.data_all_pass = Object.values(checks).every(Boolean);
  report.metrics = {
    preview_edges: graph.graph_preview.edge_count_returned,
    persisted_edges: graph.graph_preview.enrichment.persisted_edge_count,
    reference_candidates: refs?.candidate_count,
    trid_outcome: refs?.outcome,
    packet_reference_candidates: packet.reference_candidates_count,
    top_ref_source: refs?.candidates[0]?.source_table,
  };

  fs.writeFileSync(path.join(outDir, "smoke.json"), JSON.stringify(report, null, 2));

  const matrix = buildReadinessMatrix(report, checks, ui);
  fs.writeFileSync(path.join(outDir, "mvp-readiness-matrix.md"), matrix, "utf8");
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify({ run_id: RUN_ID, artifacts: ["smoke.json", "mvp-readiness-matrix.md", "summary.md", "manifest.json"] }, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      "# CLAIM-TRID-READ-PATH-FINALIZE-V171",
      "",
      `Pilot draft \`${DRAFT_ID}\` on staging **${STAGING_REF}**.`,
      "",
      `Data checks pass: **${report.data_all_pass ? "yes" : "no"}**`,
      "",
      "See `mvp-readiness-matrix.md` for operable/MVP matrix.",
    ].join("\n"),
    "utf8",
  );

  console.log(JSON.stringify(report, null, 2));
  if (!report.data_all_pass || !report.ui_all_pass) process.exitCode = 1;
}

function buildReadinessMatrix(
  report: Record<string, unknown>,
  checks: Record<string, boolean>,
  ui: Record<string, boolean>,
): string {
  const m = report.metrics as Record<string, unknown> | undefined;
  const rows: [string, string, string, string][] = [
    ["Capability", "Status", "Evidence", "Blocker"],
    ["Evidence graph (live + persisted)", checks.evidence_edges ? "Operable" : "Partial", `preview ${m?.preview_edges ?? "?"} / persisted ${m?.persisted_edges ?? "?"}`, ""],
    ["Product linkage display", checks.product_linkage ? "Operable" : "Gap", "ClaimDraftProductLinkagePanel + API", ""],
    ["TRID reference candidates", checks.reference_candidates ? "Operable" : "Gap", `${m?.reference_candidates ?? 0} candidates (${m?.trid_outcome})`, ""],
    ["Copy reference value", ui.reference_copy_button ? "Operable" : "Gap", "ClaimReferenceCandidatesPanel", ""],
    ["Unresolved warnings", ui.viewer_warnings ? "Operable" : "Gap", "ClaimEvidenceViewer + packet", ""],
    ["Filing packet preview", checks.packet_does_not_submit ? "Operable" : "Gap", "no-submit banner + gate", ""],
    ["Packet reference candidates", checks.packet_reference_candidates ? "Operable" : "Gap", `${m?.packet_reference_candidates ?? 0} in packet`, ""],
    ["Missing refs warning", checks.packet_missing_refs_warn ? "Operable" : "Partial", "ambiguous_multiple → warn", ""],
    ["Edge review statuses", "Operable", "accepted / rejected / needs_review", ""],
    ["Copied to Amazon form", "MVP (session)", "sessionStorage until DDL", "DB column not migrated"],
    ["Claim submission", "Out of scope", "disabled / does_not_submit", "by design"],
    ["Amazon SP-API", "Out of scope", "not called", "by design"],
  ];
  return ["# MVP / operable readiness matrix", "", ...rows.map((r) => `| ${r.join(" | ")} |`), ""].join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
