/**
 * V176 — Remap draft materialization proposals whose product_id is missing from products
 * (stale source_resolved on amazon_removal_shipments) via product_identifier_map only.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Client as PgClient } from "pg";

import { extractIdentifierHints } from "./claim-artifact-projection-core";
import type { MaterializeProposal } from "./claim-candidate-resolver-materialize";
import { resolveAmazonRemovalShipmentsOperationalRow } from "./claim-operational-source-resolve";
import {
  fetchProductIdentifierMapCandidates,
  pickBestProductIdentifierMatch,
} from "./product-identifier-match";

function n(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s.length > 0 ? s : null;
}

export type OrphanRemapOutcome =
  | "remapped_identifier_map"
  | "still_orphan_source_product"
  | "ambiguous_map"
  | "unresolved_map"
  | "missing_store"
  | "missing_source_row"
  | "unsupported_source"
  | "already_valid_product";

export type OrphanRemapResult = {
  proposal: MaterializeProposal | null;
  outcome: OrphanRemapOutcome;
  original_product_id: string;
  remapped_product_id: string | null;
  reason_codes: string[];
};

export async function filterProposalsExistingInProducts(
  client: PgClient,
  proposals: MaterializeProposal[],
): Promise<{ valid: MaterializeProposal[]; invalid: MaterializeProposal[] }> {
  if (proposals.length === 0) return { valid: [], invalid: [] };
  const ids = proposals.map((p) => p.proposed_resolved_product_id);
  const res = await client.query(
    `SELECT x.id::text AS product_id
     FROM unnest($1::uuid[]) AS x(id)
     INNER JOIN public.products p ON p.id = x.id`,
    [ids],
  );
  const ok = new Set(res.rows.map((r: { product_id: string }) => r.product_id));
  const valid = proposals.filter((p) => ok.has(p.proposed_resolved_product_id));
  const invalid = proposals.filter((p) => !ok.has(p.proposed_resolved_product_id));
  return { valid, invalid };
}

function mergeHints(
  draft: Record<string, unknown>,
  source: Record<string, unknown> | null,
): { fnsku?: string | null; msku?: string | null; asin?: string | null; storeId: string | null } {
  const fromSource = source ? extractIdentifierHints(source) : null;
  const fnsku = n(draft.fnsku) ?? fromSource?.fnsku ?? null;
  const asin = n(draft.asin) ?? fromSource?.asin ?? null;
  const msku = n(draft.sku) ?? fromSource?.msku ?? null;
  const storeId = n(draft.store_id) ?? fromSource?.storeId ?? n(source?.store_id) ?? null;
  return { fnsku, msku, asin, storeId };
}

export async function remapOrphanDraftProposal(
  supabase: SupabaseClient,
  proposal: MaterializeProposal,
  draftRow: Record<string, unknown>,
): Promise<OrphanRemapResult> {
  const original = proposal.proposed_resolved_product_id;
  const orgId = proposal.organization_id;
  const sourceTable = n(proposal.source_table)?.toLowerCase() ?? "";
  const sourceRowId = n(proposal.source_row_id);
  const reason_codes: string[] = ["v176_orphan_source_product"];

  if (sourceTable !== "amazon_removal_shipments") {
    return {
      proposal: null,
      outcome: "unsupported_source",
      original_product_id: original,
      remapped_product_id: null,
      reason_codes: [...reason_codes, "not_amazon_removal_shipments"],
    };
  }

  const storeId = mergeHints(draftRow, null).storeId;
  if (!storeId) {
    return {
      proposal: null,
      outcome: "missing_store",
      original_product_id: original,
      remapped_product_id: null,
      reason_codes: [...reason_codes, "draft_missing_store_id"],
    };
  }

  let sourceRow: Record<string, unknown> | null = null;
  if (sourceRowId) {
    const resolved = await resolveAmazonRemovalShipmentsOperationalRow(supabase, orgId, sourceRowId);
    sourceRow = resolved.row;
    if (!sourceRow) {
      return {
        proposal: null,
        outcome: "missing_source_row",
        original_product_id: original,
        remapped_product_id: null,
        reason_codes: [...reason_codes, ...resolved.reason_codes],
      };
    }
    if (n(sourceRow.resolved_product_id) === original) {
      reason_codes.push("orphan_matches_source_resolved_product_id");
    }
  }

  const hints = mergeHints(draftRow, sourceRow);
  if (!hints.fnsku && !hints.msku && !hints.asin) {
    return {
      proposal: null,
      outcome: "unresolved_map",
      original_product_id: original,
      remapped_product_id: null,
      reason_codes: [...reason_codes, "no_identifiers_on_draft_or_source"],
    };
  }

  const mapRows = await fetchProductIdentifierMapCandidates(supabase, orgId, {
    organizationId: orgId,
    storeId: hints.storeId!,
    fnsku: hints.fnsku,
    msku: hints.msku,
    asin: hints.asin,
  });

  const match = pickBestProductIdentifierMatch(mapRows, {
    organizationId: orgId,
    storeId: hints.storeId!,
    fnsku: hints.fnsku,
    msku: hints.msku,
    asin: hints.asin,
  });

  if (match.status === "ambiguous") {
    return {
      proposal: null,
      outcome: "ambiguous_map",
      original_product_id: original,
      remapped_product_id: null,
      reason_codes: [...reason_codes, "identifier_map_ambiguous"],
    };
  }

  const remapped = n(match.row?.product_id);
  if (!remapped || match.status !== "resolved") {
    return {
      proposal: null,
      outcome: "unresolved_map",
      original_product_id: original,
      remapped_product_id: null,
      reason_codes: [...reason_codes, "identifier_map_unresolved"],
    };
  }

  if (remapped === original) {
    return {
      proposal: null,
      outcome: "still_orphan_source_product",
      original_product_id: original,
      remapped_product_id: remapped,
      reason_codes: [...reason_codes, "map_points_to_same_orphan_id"],
    };
  }

  return {
    proposal: {
      ...proposal,
      proposed_resolved_product_id: remapped,
      proposal_from: "identifier_map",
      final_bucket: "safe_update_candidate",
      confidence: match.confidence,
      reason_codes: [...reason_codes, "v176_remap_identifier_map"],
    },
    outcome: "remapped_identifier_map",
    original_product_id: original,
    remapped_product_id: remapped,
    reason_codes: [...reason_codes, "v176_remap_identifier_map"],
  };
}

export async function remapOrphanDraftProposalsBatch(
  supabase: SupabaseClient,
  proposals: MaterializeProposal[],
  draftById: Map<string, Record<string, unknown>>,
  opts?: { concurrency?: number },
): Promise<OrphanRemapResult[]> {
  const concurrency = opts?.concurrency ?? 12;
  const results: OrphanRemapResult[] = [];
  for (let i = 0; i < proposals.length; i += concurrency) {
    const slice = proposals.slice(i, i + concurrency);
    const chunk = await Promise.all(
      slice.map(async (p) => {
        const draft = draftById.get(p.artifact_id);
        if (!draft) {
          return {
            proposal: null,
            outcome: "missing_source_row" as const,
            original_product_id: p.proposed_resolved_product_id,
            remapped_product_id: null,
            reason_codes: ["draft_row_not_loaded"],
          };
        }
        return remapOrphanDraftProposal(supabase, p, draft);
      }),
    );
    results.push(...chunk);
  }
  return results;
}
