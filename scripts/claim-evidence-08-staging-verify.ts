/**
 * CLAIM-EVIDENCE-08 — Staging verify: bulk review schema, filing readiness, optional live bulk.
 *
 *   npm run verify:claim-evidence-08-staging
 *   CLAIM_EVIDENCE_08_LIVE_BULK=1 npm run verify:claim-evidence-08-staging
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
const RUN_ID = process.env.CLAIM_EVIDENCE_08_RUN_ID?.trim() || "20260520T160000Z";
const LIVE_BULK = process.env.CLAIM_EVIDENCE_08_LIVE_BULK === "1";

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

async function main(): Promise<void> {
  loadEnvLocal();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Missing Supabase env.");

  const client = createClient(url, key, { auth: { persistSession: false } });
  const outDir = path.resolve(process.cwd(), ".cursor/audit-reports/claim-evidence-08", RUN_ID);
  fs.mkdirSync(outDir, { recursive: true });

  const reviewSchemaOk = await probeEdgeReviewSchema(client);
  const filingSchemaOk = await probeFilingReadinessSchema(client);
  const draft = await fetchDraftRow(client, ORG_ID, DRAFT_ID);
  if (!draft) throw new Error("Draft not found.");

  const body = await buildClaimEvidenceGraphResponse(client, draft);
  const summary = await loadEdgeReviewSummary(client, ORG_ID, DRAFT_ID);
  const actionable = filterActionableWarnings(body.graph_preview.warnings);
  const localGate = computeFilingReadiness({
    reviewSummary: summary,
    warnings: body.graph_preview.warnings,
    operatorState: body.operator_state ?? null,
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
  const firstGroup = body.persisted_edges?.groups[0]?.group_key;
  if (LIVE_BULK && reviewSchemaOk && reviewedBy && firstGroup) {
    const bulk = await applyBulkEdgeOperatorReview(client, {
      organizationId: ORG_ID,
      draftId: DRAFT_ID,
      status: "accepted",
      scope: "group",
      groupKey: firstGroup,
      generationId: body.graph_preview.enrichment.latest_generation_id,
      reviewedBy,
    });
    const revert = await applyBulkEdgeOperatorReview(client, {
      organizationId: ORG_ID,
      draftId: DRAFT_ID,
      status: "needs_review",
      scope: "group",
      groupKey: firstGroup,
      generationId: body.graph_preview.enrichment.latest_generation_id,
      reviewedBy,
    });
    liveBulk = { bulk, revert };
  }

  const { data: bulkAudit } = filingSchemaOk
    ? await client
        .from("claim_reference_edge_bulk_review_events")
        .select("id, scope, edges_updated, created_at")
        .eq("organization_id", ORG_ID)
        .eq("draft_id", DRAFT_ID)
        .order("created_at", { ascending: false })
        .limit(3)
    : { data: [] };

  const checks = {
    review_schema_configured: reviewSchemaOk,
    filing_schema_configured: filingSchemaOk,
    persisted_edge_count: body.graph_preview.enrichment.persisted_edge_count,
    review_summary_total: summary.total,
    filing_readiness_in_response: body.filing_readiness != null,
    filing_gate_matches_local: JSON.stringify(body.filing_readiness) === JSON.stringify(localGate),
    actionable_warning_count: actionable.length,
    live_bulk_ran: LIVE_BULK && liveBulk != null,
  };

  const allPass =
    checks.review_schema_configured &&
    checks.filing_schema_configured &&
    checks.persisted_edge_count === 51 &&
    checks.review_summary_total === 51 &&
    checks.filing_readiness_in_response &&
    checks.filing_gate_matches_local;

  const payload = {
    prompt_name: "CLAIM-EVIDENCE-08",
    run_id: RUN_ID,
    checks,
    all_pass: allPass,
    filing_readiness: body.filing_readiness,
    operator_state: body.operator_state,
    live_bulk: liveBulk,
    recent_bulk_audit: bulkAudit ?? [],
  };

  fs.writeFileSync(path.join(outDir, "api-verification.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      "# CLAIM-EVIDENCE-08 staging verify",
      "",
      `- run_id: \`${RUN_ID}\``,
      `- all_pass: **${allPass}**`,
      `- filing schema: ${filingSchemaOk}`,
      `- filing ready (gate only): ${body.filing_readiness?.ready ?? "n/a"}`,
      `- blockers: ${(body.filing_readiness?.blockers ?? []).join(", ") || "none"}`,
      "",
      "Does not submit claims.",
    ].join("\n"),
  );

  console.log(JSON.stringify(payload, null, 2));
  process.exitCode = allPass ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
