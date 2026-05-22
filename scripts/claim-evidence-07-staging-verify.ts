/**
 * CLAIM-EVIDENCE-07 — Staging verify: review schema + optional single-edge accept/revert.
 *
 *   npx tsx scripts/claim-evidence-07-staging-verify.ts
 *   CLAIM_EVIDENCE_07_LIVE_REVIEW=1 npx tsx scripts/claim-evidence-07-staging-verify.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  applyEdgeOperatorReview,
  loadEdgeReviewSummary,
  listEdgeReviewAuditEvents,
  probeEdgeReviewSchema,
} from "../lib/claim-evidence-edge-review";
import { buildClaimEvidenceGraphResponse, fetchDraftRow } from "../lib/claim-evidence-preview";

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const DRAFT_ID = "003db7ff-23f5-4d28-b13e-e13198ea38d8";
const RUN_ID = process.env.CLAIM_EVIDENCE_07_RUN_ID?.trim() || "20260520T140000Z";
const LIVE = process.env.CLAIM_EVIDENCE_07_LIVE_REVIEW === "1";

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
  const outDir = path.resolve(process.cwd(), ".cursor/audit-reports/claim-evidence-07", RUN_ID);
  fs.mkdirSync(outDir, { recursive: true });

  const schemaOk = await probeEdgeReviewSchema(client);
  const draft = await fetchDraftRow(client, ORG_ID, DRAFT_ID);
  if (!draft) throw new Error("Draft not found.");

  const body = await buildClaimEvidenceGraphResponse(client, draft);
  const summary = schemaOk ? await loadEdgeReviewSummary(client, ORG_ID, DRAFT_ID) : null;

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

  let liveReview: Record<string, unknown> | null = null;
  if (LIVE && schemaOk && reviewedBy && body.persisted_edges?.edges[0]?.reference_edge_id) {
    const edgeId = body.persisted_edges.edges[0].reference_edge_id!;
    const accepted = await applyEdgeOperatorReview(client, {
      organizationId: ORG_ID,
      draftId: DRAFT_ID,
      edgeId,
      status: "accepted",
      reviewedBy,
    });
    const reverted = await applyEdgeOperatorReview(client, {
      organizationId: ORG_ID,
      draftId: DRAFT_ID,
      edgeId,
      status: "needs_review",
      reviewedBy,
    });
    liveReview = { accepted, reverted };
  }

  const audit = schemaOk ? await listEdgeReviewAuditEvents(client, ORG_ID, DRAFT_ID, 5) : [];

  const checks = {
    review_schema_configured: schemaOk,
    persisted_edge_count: body.graph_preview.enrichment.persisted_edge_count,
    review_summary_total: summary?.total ?? null,
    review_summary_needs_review: summary?.needs_review ?? null,
    persisted_list_has_status: schemaOk
      ? Boolean(body.persisted_edges?.edges[0]?.operator_review_status)
      : false,
    live_review_ran: LIVE && liveReview != null,
  };

  const allPass =
    checks.review_schema_configured &&
    checks.persisted_edge_count === 51 &&
    checks.review_summary_total === 51 &&
    (checks.review_summary_needs_review === 51 || checks.review_summary_needs_review! < 51);

  const payload = {
    prompt_name: "CLAIM-EVIDENCE-07",
    run_id: RUN_ID,
    checks,
    all_pass: allPass,
    live_review: liveReview,
    recent_audit: audit,
  };

  fs.writeFileSync(path.join(outDir, "api-verification.json"), JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload, null, 2));
  process.exitCode = schemaOk && checks.persisted_edge_count === 51 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
