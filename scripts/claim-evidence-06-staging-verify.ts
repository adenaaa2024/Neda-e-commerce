/**
 * NEXT-CLAIM-EVIDENCE-06 — Verify persisted edge list in graph API (read-only).
 *   npx tsx scripts/claim-evidence-06-staging-verify.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  buildClaimEvidenceGraphResponse,
  fetchDraftRow,
  resolveCandidateForDraft,
} from "../lib/claim-evidence-preview";

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const DRAFT_ID = "003db7ff-23f5-4d28-b13e-e13198ea38d8";
const GENERATION_ID = "f730d710-2a51-4f14-b299-203caa61faa8";
const RUN_ID = process.env.CLAIM_EVIDENCE_06_RUN_ID?.trim() || "20260520T120000Z";

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
  const outDir = path.resolve(process.cwd(), ".cursor/audit-reports/next-claim-evidence-06", RUN_ID);
  fs.mkdirSync(outDir, { recursive: true });

  const draft = await fetchDraftRow(client, ORG_ID, DRAFT_ID);
  if (!draft) throw new Error("Draft not found.");

  const body = await buildClaimEvidenceGraphResponse(client, draft, { includePersistedEdgeList: true });
  const graph = body.graph_preview;
  const persisted = body.persisted_edges;
  const candidate = await resolveCandidateForDraft(client, ORG_ID, draft);

  const checks = {
    persisted_edge_count: graph.enrichment.persisted_edge_count,
    generation_id: graph.enrichment.latest_generation_id,
    generation_id_match: graph.enrichment.latest_generation_id === GENERATION_ID,
    persisted_list_count: persisted?.edge_count_returned ?? 0,
    persisted_list_total: persisted?.edge_count_total ?? 0,
    persisted_list_matches_count: (persisted?.edge_count_returned ?? 0) === 51,
    persisted_groups_non_empty: (persisted?.groups.length ?? 0) > 0,
    display_mode: graph.evidence_display_mode,
    draft_deep_link: `/claim-engine/evidence?draft_id=${DRAFT_ID}`,
    claim_candidate_id: candidate?.id ?? null,
    inbox_deep_link: body.inbox_deep_link,
  };

  const allPass =
    checks.persisted_edge_count === 51 &&
    checks.generation_id_match &&
    checks.persisted_list_matches_count &&
    checks.persisted_groups_non_empty;

  const payload = { prompt_name: "NEXT-CLAIM-EVIDENCE-06", run_id: RUN_ID, checks, all_pass: allPass, body_summary: {
    persisted_edges: persisted
      ? { edge_count_returned: persisted.edge_count_returned, group_count: persisted.groups.length, generation_id: persisted.generation_id }
      : null,
    graph: { enrichment: graph.enrichment, evidence_display_mode: graph.evidence_display_mode },
  }};

  fs.writeFileSync(path.join(outDir, "api-verification.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(
    path.join(outDir, "browser-proof-urls.md"),
    `# Browser proof URLs\n\n- Draft evidence: \`/claim-engine/evidence?draft_id=${DRAFT_ID}\`\n- Inbox with draft banner: \`/claim-engine/inbox?draft_id=${DRAFT_ID}\`\n${candidate ? `- Inbox candidate: \`/claim-engine/inbox?candidate_id=${candidate.id}\`\n` : "- No claim_candidates row — use draft evidence page only.\n"}\n`,
    "utf8",
  );

  console.log(JSON.stringify(payload, null, 2));
  process.exitCode = allPass ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
