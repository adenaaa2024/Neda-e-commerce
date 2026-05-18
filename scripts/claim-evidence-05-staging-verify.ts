/**
 * NEXT-CLAIM-EVIDENCE-05 — Verify persisted edge count in evidence-graph API (staging).
 * SELECT + API build only. No writes.
 *
 *   npx tsx scripts/claim-evidence-05-staging-verify.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  buildClaimEvidencePreview,
  fetchDraftRow,
  resolveDraftForCandidate,
} from "../lib/claim-evidence-preview";

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const DRAFT_ID = "003db7ff-23f5-4d28-b13e-e13198ea38d8";
const EXPECTED_GENERATION_ID = "f730d710-2a51-4f14-b299-203caa61faa8";
const EXPECTED_PERSISTED_EDGES = 51;
const RUN_ID = process.env.CLAIM_EVIDENCE_05_RUN_ID?.trim() || "20260517T233000Z";

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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Missing Supabase env.");

  const client = createClient(url, key, { auth: { persistSession: false } });
  const outDir = path.resolve(process.cwd(), ".cursor/audit-reports/next-claim-evidence-05", RUN_ID);
  fs.mkdirSync(outDir, { recursive: true });

  const draft = await fetchDraftRow(client, ORG_ID, DRAFT_ID);
  if (!draft) throw new Error("Draft not found.");

  const graph = await buildClaimEvidencePreview(client, draft);

  const { data: candidates } = await client
    .from("claim_candidates")
    .select("id, source_table, source_row_id, sku, store_id")
    .eq("organization_id", ORG_ID)
    .eq("source_table", draft.source_table)
    .eq("source_row_id", draft.source_row_id)
    .limit(5);

  let candidateId: string | null = null;
  let candidateGraph: Awaited<ReturnType<typeof buildClaimEvidencePreview>> | null = null;
  for (const c of candidates ?? []) {
    const row = c as Record<string, unknown>;
    const cid = String(row.id ?? "");
    const resolved = await resolveDraftForCandidate(client, ORG_ID, {
      id: cid,
      source_table: String(row.source_table ?? ""),
      source_row_id: String(row.source_row_id ?? ""),
      sku: row.sku != null ? String(row.sku) : null,
      store_id: row.store_id != null ? String(row.store_id) : null,
    });
    if (resolved?.id === DRAFT_ID) {
      candidateId = cid;
      candidateGraph = await buildClaimEvidencePreview(client, resolved, { claim_candidate_id: cid });
      break;
    }
  }

  const checks = {
    persisted_edge_count: graph.enrichment.persisted_edge_count,
    persisted_edge_count_expected: EXPECTED_PERSISTED_EDGES,
    persisted_edge_count_match: graph.enrichment.persisted_edge_count === EXPECTED_PERSISTED_EDGES,
    persisted_edges_flag: graph.persisted_edges,
    evidence_display_mode: graph.evidence_display_mode,
    generation_id: graph.enrichment.latest_generation_id,
    generation_id_expected: EXPECTED_GENERATION_ID,
    generation_id_match: graph.enrichment.latest_generation_id === EXPECTED_GENERATION_ID,
    lineage_event_count: graph.enrichment.lineage_event_count,
    preview_edge_count: graph.edge_count_returned,
    has_persisted_edges_available_warning: graph.warnings.some((w) => w.code === "persisted_edges_available"),
    no_preview_only_warning_when_persisted: !graph.warnings.some((w) => w.code === "preview_only"),
    candidate_id: candidateId,
    candidate_persisted_count: candidateGraph?.enrichment.persisted_edge_count ?? null,
  };

  const allPass =
    checks.persisted_edge_count_match &&
    checks.persisted_edges_flag &&
    checks.generation_id_match &&
    checks.evidence_display_mode === "persisted_with_live_preview" &&
    checks.has_persisted_edges_available_warning &&
    checks.no_preview_only_warning_when_persisted;

  const payload = {
    prompt_name: "NEXT-CLAIM-EVIDENCE-05",
    run_id: RUN_ID,
    organization_id: ORG_ID,
    draft_id: DRAFT_ID,
    checks,
    all_pass: allPass,
    graph_preview_summary: {
      persisted_edges: graph.persisted_edges,
      evidence_display_mode: graph.evidence_display_mode,
      enrichment: graph.enrichment,
      warning_codes: graph.warnings.map((w) => w.code),
    },
  };

  fs.writeFileSync(path.join(outDir, "api-verification.json"), JSON.stringify(payload, null, 2), "utf8");
  fs.writeFileSync(
    path.join(outDir, "graph-preview-sample.json"),
    JSON.stringify({ graph_preview: graph, claim_candidate_id: candidateId }, null, 2),
    "utf8",
  );

  console.log(JSON.stringify(payload, null, 2));
  process.exitCode = allPass ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
