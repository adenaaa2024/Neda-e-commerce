/**
 * CLAIM-EVIDENCE-10 — Unit tests for packet validation (no DB).
 */

import { validateClaimFilingPacket } from "../lib/claim-filing-packet-validation";
import type { ClaimFilingPacketPreview } from "../lib/claim-filing-packet-preview";
import { buildOperatorStatusSummary } from "../lib/claim-trid-operator-status";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function minimalPacket(overrides: Partial<ClaimFilingPacketPreview> = {}): ClaimFilingPacketPreview {
  return {
    schema_version: "claim-filing-packet-preview-v1",
    generated_at: new Date().toISOString(),
    does_not_submit: true,
    draft_id: "003db7ff-23f5-4d28-b13e-e13198ea38d8",
    organization_id: "00000000-0000-0000-0000-000000000001",
    claim_candidate_id: null,
    ready_for_preview: false,
    claim_summary: {
      source_table: "amazon_removals",
      source_row_id: "r1",
      sku: "SKU1",
      store_id: null,
      generation_id: "g1",
      generation_number: 1,
      generation_status: "persisted",
      evidence_hash: "abc123",
      persisted_edge_count: 2,
      lineage_event_count: 1,
      preview_edge_count: 2,
    },
    evidence_groups: [
      {
        group_key: "financial_reference_resolver",
        label: "FRR",
        source_table: "financial_reference_resolver",
        edge_count: 2,
        review: { accepted: 0, rejected: 0, needs_review: 2 },
        edges: [
          {
            reference_edge_id: "e1",
            edge_type: "claim_to_trid",
            to_source_table: "financial_reference_resolver",
            to_source_row_id: "row1",
            reference_kind: "trid",
            reference_value: "TRID-1",
            operator_review_status: "needs_review",
            confidence_score: 0.9,
          },
          {
            reference_edge_id: "e2",
            edge_type: "operational_to_financial",
            to_source_table: "financial_reference_resolver",
            to_source_row_id: "row2",
            reference_kind: null,
            reference_value: null,
            operator_review_status: "needs_review",
            confidence_score: 0.8,
          },
        ],
      },
    ],
    lineage_links: [
      {
        id: "l1",
        event_type: "initial_snapshot",
        producer: "replay_job",
        source_table: null,
        source_row_id: null,
        report_kind: null,
        generation_id: "g1",
        created_at: new Date().toISOString(),
      },
    ],
    trid_references: [
      {
        trid_key: "TRID-1",
        source_table: "financial_reference_resolver",
        source_row_id: "row1",
        confidence_score: 0.9,
        ambiguity_group_key: null,
        ambiguity_rank: null,
        linked_edge_ids: ["e1"],
      },
    ],
    reference_candidates: [],
    reference_candidates_count: 0,
    trid_outcome: null,
    missing_references_warning: null,
    operator_status_summary: buildOperatorStatusSummary({
      edgeReview: { accepted: 0, rejected: 0, needs_review: 2, total: 2 },
      tridOutcome: null,
      referenceCandidateCount: 0,
    }),
    unresolved_warnings: [],
    filing_readiness: {
      ready: false,
      all_edges_reviewed: false,
      no_blocking_rejected: true,
      warnings_clear_or_acknowledged: true,
      blockers: ["2_edges_need_review"],
      review_summary: { accepted: 0, rejected: 0, needs_review: 2, total: 2 },
      actionable_warning_count: 0,
      warnings_acknowledged: false,
    },
    operator_state: null,
    audit_tail: {
      recent_edge_review_event_ids: [],
      recent_bulk_review_event_ids: [],
      preview_event_id: null,
    },
    ...overrides,
  };
}

function testFailsWhenNeedsReview(): void {
  const v = validateClaimFilingPacket(minimalPacket());
  assert(!v.overall_valid, "not valid with needs_review");
  assert(v.blocker_inventory.some((b) => b.code === "operator_all_reviewed"), "review blocker");
}

function testPassesWhenAllAccepted(): void {
  const p = minimalPacket({
    filing_readiness: {
      ready: true,
      all_edges_reviewed: true,
      no_blocking_rejected: true,
      warnings_clear_or_acknowledged: true,
      blockers: [],
      review_summary: { accepted: 2, rejected: 0, needs_review: 0, total: 2 },
      actionable_warning_count: 0,
      warnings_acknowledged: false,
    },
    evidence_groups: [
      {
        group_key: "g",
        label: "G",
        source_table: "financial_reference_resolver",
        edge_count: 2,
        review: { accepted: 2, rejected: 0, needs_review: 0 },
        edges: minimalPacket().evidence_groups[0]!.edges.map((e) => ({
          ...e,
          operator_review_status: "accepted",
        })),
      },
    ],
  });
  const v = validateClaimFilingPacket(p);
  assert(v.overall_valid, "valid when accepted");
  assert(v.ready_for_future_submission_layer, "future layer ready");
}

function testLineageFailWithoutEvents(): void {
  const p = minimalPacket({
    claim_summary: {
      ...minimalPacket().claim_summary,
      lineage_event_count: 0,
    },
    lineage_links: [],
  });
  const v = validateClaimFilingPacket(p);
  assert(v.matrix.find((c) => c.id === "lineage_events_present")?.status === "fail", "lineage fail");
}

async function main(): Promise<void> {
  const tests: [string, () => void][] = [
    ["needs review blocks", testFailsWhenNeedsReview],
    ["all accepted passes", testPassesWhenAllAccepted],
    ["lineage missing fails", testLineageFailWithoutEvents],
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
  process.exit(failed > 0 ? 1 : 0);
}

main();
