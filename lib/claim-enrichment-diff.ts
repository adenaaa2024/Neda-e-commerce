/**
 * NEXT-CONTINUOUS-CLAIM-ENRICHMENT-03 — Read-only enrichment diff helper (SELECT only).
 * No migrations, no writes, no claim/filing mutations.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  EnrichmentDiffConfigured,
  EnrichmentDiffNotConfigured,
  EnrichmentGenerationSummary,
  EnrichmentLineageEventSummary,
  EnrichmentReferenceEdgeSummary,
} from "./claim-enrichment-diff-types";

const GENERATIONS_TABLE = "claim_enrichment_generations";
const LINEAGE_EVENTS_TABLE = "claim_evidence_lineage_events";
const REFERENCE_EDGES_TABLE = "claim_reference_edges";
const FREEZE_STATE_TABLE = "claim_enrichment_freeze_state";

const GENERATIONS_SELECT =
  "id, generation_number, status, rules_version, confidence_before, confidence_after, operator_refresh_state, filing_refresh_state, draft_id, computed_at";

const EDGES_SELECT =
  "id, generation_id, edge_type, reference_kind, reference_value, confidence_score, ambiguity_group_key, invalidated_by_edge_id, created_at";

const EVENTS_SELECT = "id, generation_id, event_type, producer, created_at";

export function isEnrichmentTableMissingError(error: { message?: string; code?: string } | null): boolean {
  if (!error) return false;
  const msg = String(error.message ?? "").toLowerCase();
  const code = String(error.code ?? "");
  return (
    code === "42P01" ||
    msg.includes("does not exist") ||
    msg.includes("could not find the table") ||
    msg.includes("schema cache")
  );
}

async function probeTable(client: SupabaseClient, table: string): Promise<boolean> {
  const { error } = await client.from(table).select("id").limit(1);
  if (!error) return true;
  if (isEnrichmentTableMissingError(error)) return false;
  throw new Error(`${table}: ${error.message}`);
}

/**
 * Returns true only when all three CCE core tables exist (additive DDL applied).
 */
export async function enrichmentDiffSchemaAvailable(client: SupabaseClient): Promise<boolean> {
  const [a, b, c] = await Promise.all([
    probeTable(client, GENERATIONS_TABLE),
    probeTable(client, LINEAGE_EVENTS_TABLE),
    probeTable(client, REFERENCE_EDGES_TABLE),
  ]);
  return a && b && c;
}

export function parseSinceGenerationNumber(raw: string): { ok: true; value: number } | { ok: false; error: string } {
  const t = raw.trim();
  if (!t) return { ok: false, error: "since_generation is required." };
  const n = Number.parseInt(t, 10);
  if (!Number.isFinite(n) || n < 0 || String(n) !== t) {
    return { ok: false, error: "since_generation must be a non-negative integer." };
  }
  return { ok: true, value: n };
}

function asGen(row: Record<string, unknown>): EnrichmentGenerationSummary {
  return {
    id: String(row.id ?? ""),
    generation_number: typeof row.generation_number === "number" ? row.generation_number : Number(row.generation_number) || 0,
    status: row.status != null ? String(row.status) : null,
    rules_version: row.rules_version != null ? String(row.rules_version) : null,
    confidence_before:
      typeof row.confidence_before === "number"
        ? row.confidence_before
        : row.confidence_before != null
          ? Number(row.confidence_before)
          : null,
    confidence_after:
      typeof row.confidence_after === "number"
        ? row.confidence_after
        : row.confidence_after != null
          ? Number(row.confidence_after)
          : null,
    operator_refresh_state: row.operator_refresh_state != null ? String(row.operator_refresh_state) : null,
    filing_refresh_state: row.filing_refresh_state != null ? String(row.filing_refresh_state) : null,
    computed_at: row.computed_at != null ? String(row.computed_at) : null,
  };
}

function asEdge(row: Record<string, unknown>): EnrichmentReferenceEdgeSummary {
  return {
    id: String(row.id ?? ""),
    generation_id: String(row.generation_id ?? ""),
    edge_type: row.edge_type != null ? String(row.edge_type) : null,
    reference_kind: row.reference_kind != null ? String(row.reference_kind) : null,
    reference_value: row.reference_value != null ? String(row.reference_value) : null,
    confidence_score:
      typeof row.confidence_score === "number"
        ? row.confidence_score
        : row.confidence_score != null
          ? Number(row.confidence_score)
          : null,
    ambiguity_group_key: row.ambiguity_group_key != null ? String(row.ambiguity_group_key) : null,
    invalidated_by_edge_id: row.invalidated_by_edge_id != null ? String(row.invalidated_by_edge_id) : null,
    created_at: row.created_at != null ? String(row.created_at) : null,
  };
}

function asEvent(row: Record<string, unknown>): EnrichmentLineageEventSummary {
  return {
    id: String(row.id ?? ""),
    generation_id: String(row.generation_id ?? ""),
    event_type: row.event_type != null ? String(row.event_type) : null,
    producer: row.producer != null ? String(row.producer) : null,
    created_at: row.created_at != null ? String(row.created_at) : null,
  };
}

const TERMINAL_FILING_STATUSES = new Set(["terminal_success", "terminal_failure", "cancelled"]);

export async function getClaimEnrichmentDiff(args: {
  readonly client: SupabaseClient;
  readonly organizationId: string;
  readonly draftId: string;
  readonly sinceGeneration: number;
  readonly includeEdges: boolean;
  readonly includeEvents: boolean;
  readonly maxEdges: number;
  readonly maxEvents: number;
}): Promise<
  | { ok: true; body: EnrichmentDiffConfigured }
  | { ok: false; status: number; error: string }
  | { ok: "not_configured"; body: EnrichmentDiffNotConfigured }
> {
  const configured = await enrichmentDiffSchemaAvailable(args.client);
  if (!configured) {
    const body: EnrichmentDiffNotConfigured = {
      configured: false,
      reason: "claim enrichment tables are not installed",
      draft_id: args.draftId,
      since_generation: String(args.sinceGeneration),
      organization_id: args.organizationId,
      changes: [],
      next_required_step: "apply additive CCE DDL in a later governed migration",
    };
    return { ok: "not_configured", body };
  }

  const { data: draft, error: dErr } = await args.client
    .from("claim_candidate_drafts")
    .select("id, organization_id, store_id, confidence_score")
    .eq("id", args.draftId)
    .eq("organization_id", args.organizationId)
    .maybeSingle();
  if (dErr) return { ok: false, status: 500, error: dErr.message };
  if (!draft) return { ok: false, status: 404, error: "Draft not found for this organization." };

  const storeId = (draft as { store_id?: string | null }).store_id ?? null;

  const { data: latestRow, error: lErr } = await args.client
    .from(GENERATIONS_TABLE)
    .select(GENERATIONS_SELECT)
    .eq("draft_id", args.draftId)
    .eq("organization_id", args.organizationId)
    .order("generation_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lErr) return { ok: false, status: 500, error: lErr.message };
  const latest_generation = latestRow ? asGen(latestRow as unknown as Record<string, unknown>) : null;

  const { data: sinceRows, error: sErr } = await args.client
    .from(GENERATIONS_TABLE)
    .select(GENERATIONS_SELECT)
    .eq("draft_id", args.draftId)
    .eq("organization_id", args.organizationId)
    .gt("generation_number", args.sinceGeneration)
    .order("generation_number", { ascending: true });
  if (sErr) return { ok: false, status: 500, error: sErr.message };
  const changes_since_generation = (sinceRows ?? []).map((r) => asGen(r as unknown as Record<string, unknown>));

  const genIds = changes_since_generation.map((g) => g.id).filter(Boolean);

  let new_reference_edges: EnrichmentReferenceEdgeSummary[] = [];
  if (args.includeEdges && genIds.length > 0) {
    const { data: eRows, error: eErr } = await args.client
      .from(REFERENCE_EDGES_TABLE)
      .select(EDGES_SELECT)
      .eq("organization_id", args.organizationId)
      .eq("draft_id", args.draftId)
      .in("generation_id", genIds)
      .order("created_at", { ascending: true })
      .limit(args.maxEdges);
    if (eErr) return { ok: false, status: 500, error: eErr.message };
    new_reference_edges = (eRows ?? []).map((r) => asEdge(r as unknown as Record<string, unknown>));
  }

  let lineage_events_sample: EnrichmentLineageEventSummary[] = [];
  if (args.includeEvents && genIds.length > 0) {
    const { data: evRows, error: evErr } = await args.client
      .from(LINEAGE_EVENTS_TABLE)
      .select(EVENTS_SELECT)
      .eq("organization_id", args.organizationId)
      .eq("draft_id", args.draftId)
      .in("generation_id", genIds)
      .order("created_at", { ascending: true })
      .limit(args.maxEvents);
    if (evErr) return { ok: false, status: 500, error: evErr.message };
    lineage_events_sample = (evRows ?? []).map((r) => asEvent(r as unknown as Record<string, unknown>));
  }

  let changed_confidence: number | null = null;
  if (changes_since_generation.length > 0) {
    const first = changes_since_generation[0];
    const last = changes_since_generation[changes_since_generation.length - 1];
    const before = first.confidence_before;
    const after = last.confidence_after;
    if (before != null && after != null && Number.isFinite(before) && Number.isFinite(after)) {
      changed_confidence = Math.round((after - before) * 10000) / 10000;
    }
  }

  let preterminal_filing_request_count = 0;
  let terminal_filing_request_count = 0;
  const { data: frRows, error: frErr } = await args.client
    .from("claim_filing_requests")
    .select("id, status")
    .eq("organization_id", args.organizationId)
    .eq("claim_candidate_draft_id", args.draftId);
  if (frErr) {
    if (!isEnrichmentTableMissingError(frErr)) {
      return { ok: false, status: 500, error: `claim_filing_requests: ${frErr.message}` };
    }
  } else if (frRows) {
    for (const r of frRows as { status?: string }[]) {
      const st = String(r.status ?? "");
      if (TERMINAL_FILING_STATUSES.has(st)) terminal_filing_request_count += 1;
      else preterminal_filing_request_count += 1;
    }
  }

  const operator_refresh_required =
    changes_since_generation.some((g) => String(g.operator_refresh_state ?? "") === "required") ||
    (latest_generation != null &&
      latest_generation.generation_number > args.sinceGeneration &&
      String(latest_generation.operator_refresh_state ?? "") === "required");

  const filing_refresh_required =
    changes_since_generation.length > 0 &&
    preterminal_filing_request_count > 0 &&
    !changes_since_generation.every((g) => String(g.filing_refresh_state ?? "") === "blocked_by_terminal");

  let freeze_state: EnrichmentDiffConfigured["freeze_state"] = null;
  const freezeOk = await probeTable(args.client, FREEZE_STATE_TABLE);
  if (freezeOk) {
    const { data: fz, error: fzErr } = await args.client
      .from(FREEZE_STATE_TABLE)
      .select("freeze_state, freeze_reason")
      .eq("draft_id", args.draftId)
      .eq("organization_id", args.organizationId)
      .maybeSingle();
    if (!fzErr && fz && typeof fz === "object") {
      const o = fz as unknown as Record<string, unknown>;
      freeze_state = {
        state: String(o.freeze_state ?? "open"),
        reason: o.freeze_reason != null ? String(o.freeze_reason) : null,
      };
    }
  }

  const body: EnrichmentDiffConfigured = {
    configured: true,
    draft_id: args.draftId,
    organization_id: args.organizationId,
    store_id: storeId,
    since_generation: args.sinceGeneration,
    latest_generation,
    changes_since_generation,
    new_reference_edges,
    lineage_events_sample,
    changed_confidence,
    filing_refresh_required,
    operator_refresh_required,
    preterminal_filing_request_count,
    terminal_filing_request_count,
    freeze_state,
    source_citations: [
      { kind: "cce02_plan", ref: ".cursor/audit-reports/next-continuous-claim-enrichment-02/20260515T211000Z-plan/diff-api-contract.md" },
    ],
  };

  return { ok: true, body };
}
