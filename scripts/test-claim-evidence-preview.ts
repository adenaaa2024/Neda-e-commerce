/**
 * NEXT-CLAIM-EVIDENCE-03 — Unit tests for evidence preview grouping (no DB).
 * Run: npm run test:claim-evidence-preview
 */

import {
  buildPreviewEdgesForDraft,
  buildPreviewWarnings,
  extractTridCandidates,
  groupPreviewEdges,
  previewEdgeId,
  resolveEvidenceDisplayMode,
  type ClaimEvidenceDraftRow,
  type ClaimEvidencePreviewEdge,
} from "../lib/claim-evidence-preview";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const draft: ClaimEvidenceDraftRow = {
  id: "00000000-0000-4000-8000-000000000099",
  organization_id: "00000000-0000-4000-8000-000000000001",
  store_id: null,
  source_table: "amazon_removals",
  source_row_id: "00000000-0000-4000-8000-000000000010",
  sku: "SKU-1",
};

function testEdgeIdStable(): void {
  const a = previewEdgeId(draft.id, ["a", "b"]);
  const b = previewEdgeId(draft.id, ["a", "b"]);
  assert(a === b, "edge id stable");
  assert(a.startsWith("preview:"), "preview prefix");
}

function testGroupBySource(): void {
  const edges: ClaimEvidencePreviewEdge[] = [
    {
      edge_id: "1",
      draft_id: draft.id,
      organization_id: draft.organization_id,
      edge_type: "claim_to_trid",
      from_node_kind: "x",
      from_source_table: "a",
      from_source_row_id: "1",
      to_node_kind: "y",
      to_source_table: "b",
      to_source_row_id: "2",
      reference_kind: "internal_trid_key",
      reference_value: "TRID-1",
      confidence_score: 0.9,
      ambiguity_group_key: null,
      ambiguity_rank: null,
      edge_reason: "test",
      source_table: "financial_reference_resolver",
      source_citations: [],
    },
    {
      edge_id: "2",
      draft_id: draft.id,
      organization_id: draft.organization_id,
      edge_type: "claim_to_removal",
      from_node_kind: "x",
      from_source_table: "a",
      from_source_row_id: "1",
      to_node_kind: "y",
      to_source_table: "b",
      to_source_row_id: "2",
      reference_kind: null,
      reference_value: null,
      confidence_score: 1,
      ambiguity_group_key: null,
      ambiguity_rank: null,
      edge_reason: "test",
      source_table: "amazon_removals",
      source_citations: [],
    },
  ];
  const groups = groupPreviewEdges(edges);
  assert(groups.length === 2, "two groups");
  assert(groups[0]!.source_table === "financial_reference_resolver", "sorted by count");
}

function testTridExtract(): void {
  const edges = buildPreviewEdgesForDraft(
    draft,
    { id: draft.source_row_id, order_id: "ORDER-1", sku: "SKU-1", fnsku: null },
    undefined,
    [],
    [
      {
        trid_key: "trid:a",
        source_table: "financial_reference_resolver",
        source_row_id: "row-1",
        confidence_score: 0.8,
      },
    ],
    [],
    [],
    new Map(),
  );
  const trids = extractTridCandidates(edges);
  assert(trids.length >= 1, "trid candidates");
  assert(trids[0]!.trid_key === "trid:a", "trid key");
}

function testWarningsPreviewOnly(): void {
  const w = buildPreviewWarnings(draft, [], { inbox_queue: "evidence_missing" });
  assert(w.some((x) => x.code === "preview_only"), "preview_only warning");
  assert(w.some((x) => x.code === "no_evidence_edges"), "no edges warning");
}

function testDisplayModeWithPersisted(): void {
  assert(resolveEvidenceDisplayMode(51, 51) === "persisted_with_live_preview", "display mode");
  assert(resolveEvidenceDisplayMode(0, 10) === "preview_only", "preview only");
  assert(resolveEvidenceDisplayMode(5, 0) === "persisted", "persisted only");
}

function testWarningsWhenPersisted(): void {
  const w = buildPreviewWarnings(draft, [], { persisted_edge_count: 51 });
  assert(w.some((x) => x.code === "persisted_edges_available"), "persisted warning");
  assert(!w.some((x) => x.code === "preview_only"), "no preview only");
}

async function main(): Promise<void> {
  const tests: [string, () => void][] = [
    ["edge id stable", testEdgeIdStable],
    ["group by source", testGroupBySource],
    ["trid extract", testTridExtract],
    ["warnings", testWarningsPreviewOnly],
    ["display mode persisted", testDisplayModeWithPersisted],
    ["warnings when persisted", testWarningsWhenPersisted],
  ];
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      fn();
      console.log(`ok ${name}`);
    } catch (e) {
      failed++;
      console.error(`FAIL ${name}:`, e instanceof Error ? e.message : e);
    }
  }
  if (failed > 0) process.exit(1);
  console.log(`\n${tests.length}/${tests.length} passed`);
}

main();
