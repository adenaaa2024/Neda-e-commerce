/**
 * Claim Discovery Engine — scheduled + manual incremental candidate discovery.
 * Writes claim_candidates only (never claim_cases / claim_lines).
 */
import type { ClaimSourceKind } from "../intake/claim-intake-types";
import type { InboxQueue, ProjectedCandidate } from "../../claim-inbox-projection";

import { CLAIM_DISCOVERY_SOURCE_KINDS } from "../../platform-automation-settings-types";

export { CLAIM_DISCOVERY_SOURCE_KINDS };

export type ClaimDiscoverySourceKind = (typeof CLAIM_DISCOVERY_SOURCE_KINDS)[number];

export function isClaimDiscoverySourceKind(v: unknown): v is ClaimDiscoverySourceKind {
  return typeof v === "string" && (CLAIM_DISCOVERY_SOURCE_KINDS as readonly string[]).includes(v);
}

export type ClaimDiscoverySourceIndex = {
  /** Inclusive ISO date floor used on the last successful indexed run. */
  last_through_date: string | null;
  last_run_at: string | null;
  last_run_id: string | null;
  rows_indexed: number;
};

export type ClaimDiscoveryIndexState = {
  version: 1;
  sources: Partial<Record<ClaimDiscoverySourceKind, ClaimDiscoverySourceIndex>>;
  updated_at: string | null;
};

export type { ClaimDiscoverySchedule } from "../../platform-automation-settings-types";

export type IndexedSourceResult = {
  source_kind: ClaimDiscoverySourceKind;
  window: { from: string; to: string };
  strategy: "incremental_watermark" | "manual_window" | "initial_lookback";
  prior_watermark: string | null;
  matched: number;
  drafts: number;
  inserted: number;
  updated: number;
  watermark_advanced_to: string;
};

export type DiscoveryEligibilityRow = {
  candidate_id: string;
  source_kind: ClaimSourceKind;
  claim_family: string | null;
  inbox_queue: InboxQueue;
  automation_allowed: boolean;
  confidence_score: number | null;
  recovery_value: number | null;
  reference_id: string | null;
  event_date: string | null;
  projection: ProjectedCandidate;
};

export type ClaimDiscoveryRunOutcome = {
  ok: boolean;
  run_id: string;
  mode: "dry_run" | "apply";
  run_kind: "scheduled" | "manual";
  indexed_sources: IndexedSourceResult[];
  candidate_queue: DiscoveryEligibilityRow[];
  counts: {
    sources_ran: number;
    generated: number;
    updated: number;
    queue_eligible: number;
    queue_total: number;
    errors: number;
  };
  index_state: ClaimDiscoveryIndexState;
  error: string | null;
};
