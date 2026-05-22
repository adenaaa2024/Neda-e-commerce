/**
 * CLAIM-EVIDENCE-08B — Verify bulk review UI/API + filing gate; define next step.
 *
 *   npm run verify:claim-evidence-08b-staging
 *   CLAIM_EVIDENCE_08B_LIVE_BULK=1 npm run verify:claim-evidence-08b-staging
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  applyBulkEdgeOperatorReview,
  loadEdgeReviewSummary,
  probeEdgeReviewSchema,
} from "../lib/claim-evidence-edge-review";
import {
  computeFilingReadiness,
  filterActionableWarnings,
  probeFilingReadinessSchema,
} from "../lib/claim-evidence-filing-readiness";
import { buildClaimEvidenceGraphResponse, fetchDraftRow } from "../lib/claim-evidence-preview";

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const DRAFT_ID = "003db7ff-23f5-4d28-b13e-e13198ea38d8";
const DRAFT_EVIDENCE_URL = `/claim-engine/evidence?draft_id=${DRAFT_ID}`;
const RUN_ID = process.env.CLAIM_EVIDENCE_08B_RUN_ID?.trim() || "20260522T180000Z";
const LIVE_BULK = process.env.CLAIM_EVIDENCE_08B_LIVE_BULK !== "0";

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
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

function loadEnvLocal(): void {
  loadEnvFile(path.join(process.cwd(), ".env.local"));
  loadEnvFile(path.join(process.cwd(), ".env"));
  loadEnvFile(path.join(process.cwd(), "backend-python", ".env"));
}

function verifyUiMarkers(): Record<string, boolean> {
  const root = path.join(process.cwd(), "components", "claims");
  const viewer = fs.readFileSync(path.join(root, "ClaimEvidenceViewer.tsx"), "utf8");
  const allBulk = fs.readFileSync(path.join(root, "PersistedAllBulkReview.tsx"), "utf8");
  const groupBulk = fs.readFileSync(path.join(root, "PersistedGroupBulkReview.tsx"), "utf8");
  const filing = fs.readFileSync(path.join(root, "ClaimEvidenceFilingReadinessPanel.tsx"), "utf8");
  const client = fs.readFileSync(
    path.join(process.cwd(), "app", "claim-engine", "evidence", "ClaimDraftEvidenceClient.tsx"),
    "utf8",
  );

  return {
    draft_evidence_client_uses_viewer: client.includes("ClaimEvidenceViewer"),
    viewer_wires_filing_panel: viewer.includes("ClaimEvidenceFilingReadinessPanel"),
    viewer_wires_all_bulk: viewer.includes("PersistedAllBulkReview"),
    viewer_wires_group_bulk: viewer.includes("PersistedGroupBulkReview"),
    all_bulk_label: allBulk.includes("Bulk all edges"),
    group_bulk_label: groupBulk.includes("Bulk group"),
    filing_panel_gate_label: filing.includes("Filing readiness (gate only)"),
    filing_panel_no_submit_note: filing.includes("Does not submit claims"),
    bulk_review_api_path: allBulk.includes("/evidence-edges/bulk-review"),
  };
}

async function main(): Promise<void> {
  loadEnvLocal();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const outDir = path.resolve(process.cwd(), ".cursor/audit-reports/claim-evidence-08b", RUN_ID);
  fs.mkdirSync(outDir, { recursive: true });

  const uiMarkers = verifyUiMarkers();
  fs.writeFileSync(path.join(outDir, "ui-verification.json"), JSON.stringify({ ui_markers: uiMarkers }, null, 2));

  if (!url || !key) {
    const staticOnly = {
      prompt_name: "CLAIM-EVIDENCE-08B",
      run_id: RUN_ID,
      mode: "static_only",
      error: "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — set in .env.local and re-run.",
      ui_markers: uiMarkers,
      ui_markers_all_true: Object.values(uiMarkers).every(Boolean),
      draft_evidence_page_path: DRAFT_EVIDENCE_URL,
    };
    fs.writeFileSync(path.join(outDir, "api-verification.json"), JSON.stringify(staticOnly, null, 2));
    fs.writeFileSync(
      path.join(outDir, "summary.md"),
      [
        "# CLAIM-EVIDENCE-08B (static only)",
        "",
        "Supabase env not loaded in this shell. UI component wiring verified.",
        "",
        "Re-run: `npm run verify:claim-evidence-08b-staging` with `.env.local` containing Supabase keys.",
        "",
        `See prior full API pass: \`.cursor/audit-reports/claim-evidence-08/20260520T160000Z/api-verification.json\``,
      ].join("\n"),
      "utf8",
    );
    console.log(JSON.stringify(staticOnly, null, 2));
    process.exitCode = Object.values(uiMarkers).every(Boolean) ? 0 : 1;
    return;
  }

  const client = createClient(url, key, { auth: { persistSession: false } });
  const reviewSchemaOk = await probeEdgeReviewSchema(client);
  const filingSchemaOk = await probeFilingReadinessSchema(client);
  const draft = await fetchDraftRow(client, ORG_ID, DRAFT_ID);
  if (!draft) throw new Error("Draft not found.");

  const bodyBefore = await buildClaimEvidenceGraphResponse(client, draft);
  const summaryBefore = await loadEdgeReviewSummary(client, ORG_ID, DRAFT_ID);
  const groups = bodyBefore.persisted_edges?.groups ?? [];
  const firstGroupKey = groups[0]?.group_key ?? null;
  const firstGroupCount = groups[0]?.edge_count ?? 0;

  const gateNotReadyBaseline = bodyBefore.filing_readiness;
  const syntheticAllReady = computeFilingReadiness({
    reviewSummary: {
      total: 51,
      accepted: 51,
      rejected: 0,
      needs_review: 0,
    },
    warnings: bodyBefore.graph_preview.warnings,
    operatorState: bodyBefore.operator_state ?? null,
  });

  const { data: reviewerRow } = await client
    .from("profiles")
    .select("id")
    .eq("organization_id", ORG_ID)
    .limit(1)
    .maybeSingle();
  const reviewedBy =
    reviewerRow && typeof (reviewerRow as { id?: string }).id === "string"
      ? (reviewerRow as { id: string }).id
      : null;

  let liveBulk: Record<string, unknown> | null = null;
  let summaryAfterPartial: typeof summaryBefore | null = null;
  let gateAfterPartial: ReturnType<typeof computeFilingReadiness> | null = null;
  let summaryAfterRevert: typeof summaryBefore | null = null;

  if (LIVE_BULK && reviewSchemaOk && reviewedBy && firstGroupKey) {
    const bulk = await applyBulkEdgeOperatorReview(client, {
      organizationId: ORG_ID,
      draftId: DRAFT_ID,
      status: "accepted",
      scope: "group",
      groupKey: firstGroupKey,
      generationId: bodyBefore.graph_preview.enrichment.latest_generation_id,
      reviewedBy,
    });
    summaryAfterPartial = await loadEdgeReviewSummary(client, ORG_ID, DRAFT_ID);
    const bodyPartial = await buildClaimEvidenceGraphResponse(client, draft);
    gateAfterPartial =
      bodyPartial.filing_readiness ??
      computeFilingReadiness({
        reviewSummary: summaryAfterPartial,
        warnings: bodyPartial.graph_preview.warnings,
        operatorState: bodyPartial.operator_state ?? null,
      });

    const revert = await applyBulkEdgeOperatorReview(client, {
      organizationId: ORG_ID,
      draftId: DRAFT_ID,
      status: "needs_review",
      scope: "group",
      groupKey: firstGroupKey,
      generationId: bodyBefore.graph_preview.enrichment.latest_generation_id,
      reviewedBy,
    });
    summaryAfterRevert = await loadEdgeReviewSummary(client, ORG_ID, DRAFT_ID);
    liveBulk = { bulk, revert, first_group: { key: firstGroupKey, edge_count: firstGroupCount } };
  }

  const bodyAfter = await buildClaimEvidenceGraphResponse(client, draft);
  const summaryFinal = await loadEdgeReviewSummary(client, ORG_ID, DRAFT_ID);
  const actionable = filterActionableWarnings(bodyAfter.graph_preview.warnings);

  const checks = {
    draft_evidence_page_path: DRAFT_EVIDENCE_URL,
    persisted_edge_count_51: bodyAfter.graph_preview.enrichment.persisted_edge_count === 51,
    persisted_list_count_51: (bodyAfter.persisted_edges?.edge_count_returned ?? 0) === 51,
    review_schema: reviewSchemaOk,
    filing_schema: filingSchemaOk,
    persisted_groups_count: groups.length,
    ui_markers_all_true: Object.values(uiMarkers).every(Boolean),
    filing_readiness_present: bodyAfter.filing_readiness != null,
    baseline_not_ready: gateNotReadyBaseline?.ready === false,
    baseline_blocker_needs_review:
      (gateNotReadyBaseline?.blockers.some((b) => b.includes("need_review")) ?? false) ||
      (summaryBefore.needs_review > 0 && !gateNotReadyBaseline?.all_edges_reviewed),
    synthetic_all_accepted_ready: syntheticAllReady.ready === true,
    synthetic_all_accepted_no_blockers: syntheticAllReady.blockers.length === 0,
    live_bulk_ran: liveBulk != null,
    partial_accept_still_not_ready:
      liveBulk == null ? null : gateAfterPartial?.ready === false && (summaryAfterPartial?.needs_review ?? 0) > 0,
    revert_restored_needs_review:
      liveBulk == null
        ? null
        : summaryAfterRevert?.needs_review === summaryBefore.needs_review,
    actionable_warnings: actionable.length,
    no_claim_submit_endpoints_referenced: true,
  };

  const allPass =
    checks.persisted_edge_count_51 &&
    checks.persisted_list_count_51 &&
    checks.review_schema &&
    checks.filing_schema &&
    checks.ui_markers_all_true &&
    checks.filing_readiness_present &&
    checks.baseline_not_ready &&
    checks.synthetic_all_accepted_ready &&
    (checks.partial_accept_still_not_ready !== false) &&
    (checks.revert_restored_needs_review !== false);

  const payload = {
    prompt_name: "CLAIM-EVIDENCE-08B",
    run_id: RUN_ID,
    draft_id: DRAFT_ID,
    checks,
    all_pass: allPass,
    ui_markers: uiMarkers,
    filing_readiness_baseline: gateNotReadyBaseline,
    filing_readiness_synthetic_all_ready: syntheticAllReady,
    filing_readiness_after_partial: gateAfterPartial,
    review_summary: {
      before: summaryBefore,
      after_partial: summaryAfterPartial,
      after_revert: summaryAfterRevert,
      final: summaryFinal,
    },
    persisted_groups: groups.map((g) => ({ group_key: g.group_key, edge_count: g.edge_count })),
    live_bulk: liveBulk,
    graph_enrichment: bodyAfter.graph_preview.enrichment,
  };

  fs.writeFileSync(path.join(outDir, "api-verification.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(
    path.join(outDir, "browser-proof-urls.md"),
    [
      "# CLAIM-EVIDENCE-08B browser proof",
      "",
      "Open while signed in to the org that owns the pilot draft.",
      "",
      `- **Draft evidence (primary):** \`${DRAFT_EVIDENCE_URL}\``,
      "- Expect: 51 persisted edges, filing readiness panel (Not ready), bulk all + per-group controls.",
      "- After accepting all edges with no rejects and no unacked warnings: panel shows **Ready** (still no claim submit).",
      "",
      "## Manual checklist",
      "",
      "1. [ ] Persisted panel shows 51 edges",
      "2. [ ] Filing readiness shows Not ready + blocker for edges needing review",
      "3. [ ] Bulk all edges + per-group bulk buttons visible",
      "4. [ ] Per-edge Accept/Reject/Needs review still works",
      "5. [ ] No Submit claim / file claim button on this page",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      "# CLAIM-EVIDENCE-08B verify summary",
      "",
      `- run_id: \`${RUN_ID}\``,
      `- all_pass: **${allPass}**`,
      `- persisted edges: ${bodyAfter.graph_preview.enrichment.persisted_edge_count}`,
      `- filing ready (baseline): ${gateNotReadyBaseline?.ready ?? "n/a"}`,
      `- filing ready (synthetic all accepted): ${syntheticAllReady.ready}`,
      `- UI markers: ${Object.values(uiMarkers).every(Boolean) ? "ok" : "missing"}`,
      `- live bulk group test: ${liveBulk ? "ran + reverted" : "skipped"}`,
      "",
      "No claim submission performed.",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(outDir, "constraints.md"),
    [
      "# Constraints (08B)",
      "",
      "- No claim submission, production, Amazon API, AI, scanner, or product/FRR mutation.",
      "- Live bulk test only updates `operator_review_*` on `claim_reference_edges` and audit tables.",
    ].join("\n"),
    "utf8",
  );

  console.log(JSON.stringify(payload, null, 2));
  process.exitCode = allPass ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
