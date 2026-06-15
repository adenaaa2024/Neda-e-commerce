/**
 * Phase 7C — registered claim generator framework (run engine).
 *
 * Dry-run (default): generators emit normalized drafts IN MEMORY ONLY and
 * report counts + samples. Nothing is written.
 *
 * Apply: drafts upsert into the unified claim_candidates pool keyed by
 * dedupe_key. legacy_seed rows are NEVER source truth and are NEVER revived;
 * a legacy row that shares the same physical source row as a freshly generated
 * trusted candidate is only stamped as corroborated (metadata-only).
 *
 * No automatic promotion to claim_cases — candidates land as candidate_status
 * 'detected' and stop there.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { CLAIM_INTAKE_GENERATORS } from "./claim-intake-generators";
import {
  evaluateSourceGate,
  loadClaimIntakeSettings,
  resolveClaimIntakeWindow,
} from "./claim-intake-settings";
import { loadEffectiveClaimIntakePolicy } from "./claim-intake-policy-contract";
import {
  isClaimSourceKind,
  type ClaimCandidateDraft,
  type ClaimGeneratorApplyStats,
  type ClaimGeneratorDefinition,
  type ClaimGeneratorRunResult,
  type ClaimIntakeRunSummary,
  type ClaimSourceKind,
} from "./claim-intake-types";

const SAMPLE_SIZE = 3;
const CHUNK = 100;

export function listRegisteredClaimGenerators(): Array<{
  source_kind: ClaimSourceKind;
  title: string;
  source_tables: string[];
  default_claim_family: string;
}> {
  return CLAIM_INTAKE_GENERATORS.map((g) => ({
    source_kind: g.source_kind,
    title: g.title,
    source_tables: g.source_tables,
    default_claim_family: g.default_claim_family,
  }));
}

export type ClaimIntakeRunOptions = {
  client: SupabaseClient;
  organizationId: string;
  storeId?: string | null;
  /** Restrict to selected source kinds; omit for "all enabled". */
  sources?: string[] | null;
  /** Override run window (ISO dates). */
  from?: string | null;
  to?: string | null;
  /** Write to claim_candidates. Default false (dry-run). */
  apply?: boolean;
  /** Override per-generator fetch cap. */
  rowLimit?: number | null;
  runId?: string;
  /** Soft max-runtime: generators not yet started after this many ms are skipped. */
  maxRuntimeMs?: number | null;
  /** Run origin for candidate trigger policy gating. Default "manual". */
  runKind?: "scheduled" | "manual";
};

function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Map legacy_seed rows that share a physical source row with the drafts (corroboration only — never truth). */
export async function countLegacyOverlap(
  client: SupabaseClient,
  organizationId: string,
  drafts: ClaimCandidateDraft[],
): Promise<Map<string, string>> {
  const byTable = new Map<string, string[]>();
  for (const d of drafts) {
    const list = byTable.get(d.source_table) ?? [];
    list.push(d.source_row_id);
    byTable.set(d.source_table, list);
  }
  const overlap = new Map<string, string>();
  for (const [table, ids] of byTable) {
    for (const chunk of chunked([...new Set(ids)], CHUNK)) {
      const { data, error } = await client
        .from("claim_candidates")
        .select("id, source_row_id")
        .eq("organization_id", organizationId)
        .eq("source_kind", "legacy_seed")
        .eq("source_table", table)
        .in("source_row_id", chunk);
      if (error) throw new Error(error.message);
      for (const row of (data ?? []) as Array<{ id: string; source_row_id: string }>) {
        overlap.set(`${table}:${row.source_row_id}`, row.id);
      }
    }
  }
  return overlap;
}

function referenceTypeForDraft(d: ClaimCandidateDraft): string | null {
  if (d.reference_type) return d.reference_type;
  if (!d.reference_key) return null;
  const edge = d.reference_edges.find((e) => e.reference_value === d.reference_key);
  return edge?.reference_kind ?? null;
}

function draftToInsertRow(d: ClaimCandidateDraft, runId: string): Record<string, unknown> {
  return {
    organization_id: d.organization_id,
    store_id: d.store_id,
    source_kind: d.source_kind,
    source_table: d.source_table,
    source_row_id: d.source_row_id,
    claim_family: d.claim_family,
    claim_reason: d.claim_reason,
    dedupe_key: d.dedupe_key,
    source_event_key: d.source_event_key,
    sku: d.product.sku,
    fnsku: d.product.fnsku,
    asin: d.product.asin,
    resolved_product_id: d.product.resolved_product_id,
    expected_quantity: d.expected_quantity,
    actual_quantity: d.actual_quantity,
    delta_quantity: d.delta_quantity,
    expected_units: d.expected_quantity,
    expected_amount: d.expected_amount,
    currency: d.currency ?? "USD",
    event_date: d.event_date,
    reference_id: d.reference_key,
    reference_type: referenceTypeForDraft(d),
    dispute_deadline: d.dispute_deadline,
    days_remaining: d.days_remaining,
    recovery_value: d.recovery_value ?? d.expected_amount,
    cogs_unit: d.cogs_unit,
    candidate_status: "detected",
    evidence_status: "missing",
    confidence_score: d.confidence_score,
    package_id: (d.metadata.package_id as string | null) ?? null,
    pallet_id: (d.metadata.pallet_id as string | null) ?? null,
    return_item_id: (d.metadata.return_item_id as string | null) ?? null,
    expected_package_id: (d.metadata.expected_package_id as string | null) ?? null,
    shipment_scope_key: (d.metadata.shipment_scope_key as string | null) ?? null,
    intake_run_id: runId,
    metadata: {
      ...d.metadata,
      reference_key: d.reference_key,
      evidence_pointers: d.evidence_pointers,
      reference_edges: d.reference_edges,
      ...(d.evidence_summary ? { evidence_summary: d.evidence_summary } : {}),
    },
  };
}

export async function applyDrafts(
  client: SupabaseClient,
  organizationId: string,
  drafts: ClaimCandidateDraft[],
  legacyOverlap: Map<string, string>,
  runId: string,
): Promise<ClaimGeneratorApplyStats> {
  const stats: ClaimGeneratorApplyStats = {
    inserted: 0,
    updated_existing_trusted: 0,
    skipped_identity_conflict: 0,
    legacy_corroborated: 0,
  };

  // 1) Existing rows by dedupe_key (trusted upsert target).
  const existingByDedupe = new Map<string, { id: string; source_kind: string | null }>();
  for (const chunk of chunked(drafts.map((d) => d.dedupe_key), CHUNK)) {
    const { data, error } = await client
      .from("claim_candidates")
      .select("id, dedupe_key, source_kind")
      .eq("organization_id", organizationId)
      .in("dedupe_key", chunk);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as Array<{ id: string; dedupe_key: string; source_kind: string | null }>) {
      existingByDedupe.set(row.dedupe_key, { id: row.id, source_kind: row.source_kind });
    }
  }

  // 2) Identity conflicts on the pre-7B unique constraint
  //    (org, source_table, source_row_id, claim_family) — any row, any source_kind.
  const identityConflicts = new Set<string>();
  const byTableFamily = new Map<string, ClaimCandidateDraft[]>();
  for (const d of drafts) {
    const k = `${d.source_table}\u0000${d.claim_family}`;
    const list = byTableFamily.get(k) ?? [];
    list.push(d);
    byTableFamily.set(k, list);
  }
  for (const [key, list] of byTableFamily) {
    const [table, family] = key.split("\u0000");
    for (const chunk of chunked([...new Set(list.map((d) => d.source_row_id))], CHUNK)) {
      const { data, error } = await client
        .from("claim_candidates")
        .select("source_row_id, dedupe_key")
        .eq("organization_id", organizationId)
        .eq("source_table", table!)
        .eq("claim_family", family!)
        .is("quarantined_at", null)
        .is("rejected_at", null)
        .neq("source_kind", "legacy_seed")
        .in("source_row_id", chunk);
      if (error) throw new Error(error.message);
      for (const row of (data ?? []) as Array<{ source_row_id: string; dedupe_key: string | null }>) {
        identityConflicts.add(`${table}:${family}:${row.source_row_id}:${row.dedupe_key ?? ""}`);
      }
    }
  }

  const toInsert: Record<string, unknown>[] = [];
  for (const d of drafts) {
    const existing = existingByDedupe.get(d.dedupe_key);
    if (existing) {
      if (existing.source_kind === "legacy_seed") {
        // Defensive: a legacy row must never be the dedupe target — skip, never revive.
        stats.skipped_identity_conflict += 1;
        continue;
      }
      const { error } = await client
        .from("claim_candidates")
        .update({
          source_event_key: d.source_event_key,
          expected_quantity: d.expected_quantity,
          actual_quantity: d.actual_quantity,
          delta_quantity: d.delta_quantity,
          expected_amount: d.expected_amount,
          event_date: d.event_date,
          reference_id: d.reference_key,
          reference_type: referenceTypeForDraft(d),
          dispute_deadline: d.dispute_deadline,
          days_remaining: d.days_remaining,
          recovery_value: d.recovery_value ?? d.expected_amount,
          cogs_unit: d.cogs_unit,
          claim_reason: d.claim_reason,
          confidence_score: d.confidence_score,
          intake_run_id: runId,
          metadata: {
            ...d.metadata,
            reference_key: d.reference_key,
            evidence_pointers: d.evidence_pointers,
            reference_edges: d.reference_edges,
            ...(d.evidence_summary ? { evidence_summary: d.evidence_summary } : {}),
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id)
        .neq("source_kind", "legacy_seed");
      if (error) throw new Error(error.message);
      stats.updated_existing_trusted += 1;
      continue;
    }

    const identityKey = `${d.source_table}:${d.claim_family}:${d.source_row_id}:`;
    const conflictHit = [...identityConflicts].some(
      (c) => c.startsWith(identityKey) && !c.endsWith(`:${d.dedupe_key}`),
    );
    if (conflictHit) {
      stats.skipped_identity_conflict += 1;
      continue;
    }
    toInsert.push(draftToInsertRow(d, runId));
  }

  for (const chunk of chunked(toInsert, CHUNK)) {
    const { error } = await client.from("claim_candidates").insert(chunk);
    if (error) throw new Error(`insert failed: ${error.message}`);
    stats.inserted += chunk.length;
  }

  // 3) Legacy corroboration — metadata-only stamp; status/quarantine untouched.
  const corroborated: Array<{ legacyId: string; dedupeKey: string }> = [];
  for (const d of drafts) {
    const legacyId = legacyOverlap.get(`${d.source_table}:${d.source_row_id}`);
    if (legacyId) corroborated.push({ legacyId, dedupeKey: d.dedupe_key });
  }
  for (const { legacyId, dedupeKey } of corroborated) {
    const { data: legacyRow, error: readErr } = await client
      .from("claim_candidates")
      .select("id, metadata, source_kind")
      .eq("id", legacyId)
      .eq("source_kind", "legacy_seed")
      .maybeSingle();
    if (readErr || !legacyRow) continue;
    const meta = ((legacyRow as { metadata?: unknown }).metadata ?? {}) as Record<string, unknown>;
    const { error: updErr } = await client
      .from("claim_candidates")
      .update({
        metadata: {
          ...meta,
          corroborated_by_dedupe_key: dedupeKey,
          corroborated_at: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      })
      .eq("id", legacyId)
      .eq("source_kind", "legacy_seed");
    if (!updErr) stats.legacy_corroborated += 1;
  }

  return stats;
}

export async function runClaimIntake(options: ClaimIntakeRunOptions): Promise<ClaimIntakeRunSummary> {
  const {
    client,
    organizationId,
    storeId = null,
    sources = null,
    from = null,
    to = null,
    apply = false,
  } = options;
  const runId = options.runId ?? crypto.randomUUID();

  const { settings } = await loadClaimIntakeSettings(client, organizationId);
  const effectivePolicy = await loadEffectiveClaimIntakePolicy(
    client,
    organizationId,
    storeId,
  );
  const window = resolveClaimIntakeWindow(settings, from, to, new Date(), effectivePolicy);
  const rowLimit = options.rowLimit ?? settings.per_run_row_limit;

  if (!settings.manual_run_enabled) {
    throw new Error("Manual claim intake runs are disabled in claim_intake settings.");
  }

  const requested: ClaimSourceKind[] | null = sources
    ? sources.filter(isClaimSourceKind)
    : null;
  if (sources && requested && requested.length !== sources.length) {
    const bad = sources.filter((s) => !isClaimSourceKind(s));
    throw new Error(`Unknown source_kind values: ${bad.join(", ")}`);
  }

  const results: ClaimGeneratorRunResult[] = [];
  const deadline =
    options.maxRuntimeMs && options.maxRuntimeMs > 0 ? Date.now() + options.maxRuntimeMs : null;

  for (const gen of CLAIM_INTAKE_GENERATORS) {
    const gate = evaluateSourceGate(settings, gen.source_kind);
    const selected = requested === null || requested.includes(gen.source_kind);
    const excludedTable = gen.source_tables.some((t) =>
      settings.excluded_source_tables.includes(t),
    );

    const base: ClaimGeneratorRunResult = {
      source_kind: gen.source_kind,
      title: gen.title,
      enabled: gate.enabled,
      purchased: gate.purchased,
      ran: false,
      skip_reason: !selected
        ? "not_in_selected_sources"
        : gate.skip_reason ?? (excludedTable ? "source_table_excluded" : null),
      matched_count: 0,
      drafts_generated: 0,
      legacy_overlap_count: 0,
      sample: [],
      apply: null,
      notes: [],
      error: null,
    };

    if (!selected || gate.skip_reason || excludedTable) {
      results.push(base);
      continue;
    }
    if (deadline !== null && Date.now() > deadline) {
      base.skip_reason = "max_runtime_reached";
      results.push(base);
      continue;
    }

    try {
      const output = await gen.generate({
        client,
        organizationId,
        storeId,
        window,
        settings,
        rowLimit,
        runKind: options.runKind ?? "manual",
      });
      const legacyOverlap = await countLegacyOverlap(client, organizationId, output.drafts);

      base.ran = true;
      base.matched_count = output.matched_count;
      base.drafts_generated = output.drafts.length;
      base.legacy_overlap_count = legacyOverlap.size;
      base.sample = output.drafts.slice(0, SAMPLE_SIZE);
      base.notes = output.notes;

      if (apply && output.drafts.length > 0) {
        base.apply = await applyDrafts(client, organizationId, output.drafts, legacyOverlap, runId);
      } else if (apply) {
        base.apply = {
          inserted: 0,
          updated_existing_trusted: 0,
          skipped_identity_conflict: 0,
          legacy_corroborated: 0,
        };
      }
    } catch (e) {
      base.error = e instanceof Error ? e.message : String(e);
    }
    results.push(base);
  }

  return {
    run_id: runId,
    mode: apply ? "apply" : "dry_run",
    organization_id: organizationId,
    store_id: storeId,
    window,
    requested_sources: requested ?? "all_enabled",
    results,
    totals: {
      generators_ran: results.filter((r) => r.ran).length,
      drafts_generated: results.reduce((s, r) => s + r.drafts_generated, 0),
      inserted: results.reduce((s, r) => s + (r.apply?.inserted ?? 0), 0),
      legacy_corroborated: results.reduce((s, r) => s + (r.apply?.legacy_corroborated ?? 0), 0),
    },
  };
}
