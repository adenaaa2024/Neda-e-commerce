/**
 * NEXT-CLAIM-13 — Operational source row resolution for claim_candidate linkage (read-only helpers).
 *
 * Reduces `missing_source_row` when `source_row_id` misses but tenant-scoped operational keys still
 * match a live row (especially `amazon_removals`). Callers must handle ambiguity — never auto-merge.
 *
 * No DB writes. No storage.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export const CLAIM_SUPPORTED_SOURCE_TABLES = new Set([
  "amazon_returns",
  "amazon_removals",
  "amazon_removal_shipments",
  "return_items",
  "returns",
  /** CLAIM-CANDIDATE-RESOLVER-V175 — scanner slip lines (join by source_row_id). */
  "slip_contents",
]);

export type ClaimSourcePack = {
  row: Record<string, unknown> | null;
  alternateTier: string | null;
  opReasonCodes: string[];
  ambiguousOperational: boolean;
  /** True when `source_row_id` matched a row in the id prefetch map (no alternate needed). */
  id_lookup_hit: boolean;
};

export type OperationalAlternateKey =
  | "exact_id"
  | "order_id_sku"
  | "order_id_fnsku"
  | "order_id_asin"
  | "staging_line"
  | "amazon_order_id_sku"
  | "lpn_tracking"
  | "none";

export type OperationalSourceResolve = {
  row: Record<string, unknown> | null;
  matched_via: OperationalAlternateKey;
  ambiguous: boolean;
  match_count: number;
  reason_codes: string[];
};

/**
 * Resolve operational source row for one claim_candidate (id map + alternates).
 * Used by linkage resolver prefetch and NEXT-CLAIM-13 report.
 */
export async function resolveClaimCandidateSourcePack(
  client: SupabaseClient,
  candidate: Record<string, unknown>,
  sourceMaps: Map<string, Map<string, Record<string, unknown>>>,
  contextRow: Record<string, unknown> | null,
): Promise<ClaimSourcePack> {
  const sourceTable = nv(candidate.source_table)?.toLowerCase() ?? "";
  const sourceRowId = nv(candidate.source_row_id);
  const orgForResolve = nv(candidate.organization_id);
  const storeId = nv(candidate.store_id);

  let row: Record<string, unknown> | null =
    sourceTable && sourceRowId && CLAIM_SUPPORTED_SOURCE_TABLES.has(sourceTable)
      ? (sourceMaps.get(sourceTable)?.get(sourceRowId) ?? null)
      : null;
  const id_lookup_hit = !!row;
  let alternateTier: string | null = null;
  const opReasonCodes: string[] = [];
  let ambiguousOperational = false;

  if (!row && orgForResolve && sourceTable === "amazon_removals" && sourceRowId) {
    const hints = mergeOperationalHints(candidate, contextRow);
    const alt = await resolveAmazonRemovalsOperationalRow(client, orgForResolve, storeId, sourceRowId, hints);
    opReasonCodes.push(...alt.reason_codes.map((x) => `op:${x}`));
    if (alt.row && !alt.ambiguous) {
      row = alt.row;
      alternateTier = `operational_${alt.matched_via}`;
    } else if (alt.ambiguous) {
      ambiguousOperational = true;
      opReasonCodes.push("operational_source_ambiguous");
    }
  }

  if (!row && orgForResolve && sourceTable === "amazon_returns" && sourceRowId) {
    const hints = mergeOperationalHints(candidate, contextRow);
    const alt = await resolveAmazonReturnsOperationalRow(client, orgForResolve, sourceRowId, hints);
    opReasonCodes.push(...alt.reason_codes.map((x) => `op:${x}`));
    if (alt.row && !alt.ambiguous) {
      row = alt.row;
      alternateTier = `operational_${alt.matched_via}`;
    } else if (alt.ambiguous) {
      ambiguousOperational = true;
      opReasonCodes.push("operational_source_ambiguous");
    }
  }

  if (!row && orgForResolve && (sourceTable === "returns" || sourceTable === "return_items") && sourceRowId) {
    const alt = await resolveReturnsOperationalRow(client, orgForResolve, storeId, sourceRowId);
    opReasonCodes.push(...alt.reason_codes.map((x) => `op:${x}`));
    if (alt.row && !alt.ambiguous) {
      row = alt.row;
      alternateTier = `operational_${alt.matched_via}`;
    }
  }

  if (!row && orgForResolve && sourceTable === "amazon_removal_shipments" && sourceRowId) {
    const alt = await resolveAmazonRemovalShipmentsOperationalRow(client, orgForResolve, sourceRowId);
    opReasonCodes.push(...alt.reason_codes.map((x) => `op:${x}`));
    if (alt.row && !alt.ambiguous) {
      row = alt.row;
      alternateTier = `operational_${alt.matched_via}`;
    }
  }

  return { row, alternateTier, opReasonCodes, ambiguousOperational, id_lookup_hit };
}

function nv(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function pushReason(codes: string[], code: string): void {
  if (!codes.includes(code)) codes.push(code);
}

/** Merge identifiers from claim_candidates row + optional v_claim_candidate_source_context row. */
export function mergeOperationalHints(
  candidate: Record<string, unknown>,
  context: Record<string, unknown> | null,
): {
  order_id: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  upc: string | null;
  source_staging_id: string | null;
  upload_id: string | null;
  amazon_order_id: string | null;
  lpn: string | null;
} {
  const c = candidate;
  const x = context ?? {};
  const pick = (...vals: unknown[]) => {
    for (const v of vals) {
      const n = nv(v);
      if (n) return n;
    }
    return null;
  };
  return {
    order_id: pick(c.order_id, x.source_order_id, x.order_id, x.amazon_order_id),
    sku: pick(c.sku, x.source_sku, x.candidate_sku, x.seller_sku, x.sku),
    fnsku: pick(c.fnsku, x.candidate_fnsku, x.fnsku),
    asin: pick(c.asin, x.candidate_asin, x.asin),
    upc: pick(c.upc, x.upc, x.upc_code),
    source_staging_id: pick(c.source_staging_id, x.source_staging_id),
    upload_id: pick(c.upload_id, x.upload_id),
    amazon_order_id: pick(x.amazon_order_id, c.amazon_order_id),
    lpn: pick(x.lpn, c.lpn, x.tracking_number, c.tracking_number),
  };
}

/**
 * Resolve `amazon_removals` row: exact id (org-scoped), then alternate keys.
 */
export async function resolveAmazonRemovalsOperationalRow(
  client: SupabaseClient,
  organizationId: string,
  candidateStoreId: string | null,
  sourceRowId: string | null,
  hints: ReturnType<typeof mergeOperationalHints>,
): Promise<OperationalSourceResolve> {
  const reason_codes: string[] = [];
  const org = organizationId.trim();
  if (!org) {
    pushReason(reason_codes, "missing_organization_id");
    return { row: null, matched_via: "none", ambiguous: false, match_count: 0, reason_codes };
  }

  if (sourceRowId) {
    const { data, error } = await client
      .from("amazon_removals")
      .select("*")
      .eq("id", sourceRowId)
      .eq("organization_id", org)
      .maybeSingle();
    if (error) pushReason(reason_codes, `exact_id_query:${error.message}`);
    else if (data && typeof data === "object") {
      pushReason(reason_codes, "exact_id_hit");
      return {
        row: data as unknown as Record<string, unknown>,
        matched_via: "exact_id",
        ambiguous: false,
        match_count: 1,
        reason_codes,
      };
    }
    pushReason(reason_codes, "exact_id_miss");
  }

  const oid = hints.order_id;
  const sku = hints.sku;
  const fnsku = hints.fnsku;
  const asin = hints.asin;
  const staging = hints.source_staging_id;
  const upload = hints.upload_id;

  if (upload && staging) {
    const { data, error } = await client
      .from("amazon_removals")
      .select("*")
      .eq("organization_id", org)
      .eq("upload_id", upload)
      .eq("source_staging_id", staging)
      .limit(8);
    if (error) pushReason(reason_codes, `staging_line:${error.message}`);
    else {
      const rows = (data ?? []) as unknown as Record<string, unknown>[];
      if (rows.length === 1) {
        pushReason(reason_codes, "alternate_hit_staging_line");
        return { row: rows[0]!, matched_via: "staging_line", ambiguous: false, match_count: 1, reason_codes };
      }
      if (rows.length > 1) {
        pushReason(reason_codes, "ambiguous_staging_line");
        return { row: null, matched_via: "staging_line", ambiguous: true, match_count: rows.length, reason_codes };
      }
    }
  }

  const store = nv(candidateStoreId);

  const fetchOrderSku = async (useFnsku: boolean) => {
    if (!oid) return [] as unknown as Record<string, unknown>[];
    const keyCol = useFnsku && fnsku ? "fnsku" : "sku";
    const keyVal = useFnsku && fnsku ? fnsku : sku;
    if (!keyVal) return [];
    if (store) {
      const { data } = await client
        .from("amazon_removals")
        .select("*")
        .eq("organization_id", org)
        .eq("order_id", oid)
        .eq(keyCol, keyVal)
        .eq("store_id", store)
        .limit(8);
      const scoped = (data ?? []) as unknown as Record<string, unknown>[];
      if (scoped.length > 0) return scoped;
    }
    const { data } = await client
      .from("amazon_removals")
      .select("*")
      .eq("organization_id", org)
      .eq("order_id", oid)
      .eq(keyCol, keyVal)
      .limit(8);
    return (data ?? []) as unknown as Record<string, unknown>[];
  };

  if (oid && sku) {
    const rows = await fetchOrderSku(false);
    if (rows.length === 1) {
      pushReason(reason_codes, "alternate_hit_order_id_sku");
      return { row: rows[0]!, matched_via: "order_id_sku", ambiguous: false, match_count: 1, reason_codes };
    }
    if (rows.length > 1) {
      pushReason(reason_codes, "ambiguous_order_id_sku");
      return { row: null, matched_via: "order_id_sku", ambiguous: true, match_count: rows.length, reason_codes };
    }
  }

  if (oid && fnsku) {
    const rows = await fetchOrderSku(true);
    if (rows.length === 1) {
      pushReason(reason_codes, "alternate_hit_order_id_fnsku");
      return { row: rows[0]!, matched_via: "order_id_fnsku", ambiguous: false, match_count: 1, reason_codes };
    }
    if (rows.length > 1) {
      pushReason(reason_codes, "ambiguous_order_id_fnsku");
      return { row: null, matched_via: "order_id_fnsku", ambiguous: true, match_count: rows.length, reason_codes };
    }
  }

  if (oid && asin) {
    const { data, error } = await client
      .from("amazon_removals")
      .select("*")
      .eq("organization_id", org)
      .eq("order_id", oid)
      .eq("asin", asin)
      .limit(8);
    if (error) pushReason(reason_codes, `order_id_asin:${error.message}`);
    else {
      const rows = (data ?? []) as unknown as Record<string, unknown>[];
      if (rows.length === 1) {
        pushReason(reason_codes, "alternate_hit_order_id_asin");
        return { row: rows[0]!, matched_via: "order_id_asin", ambiguous: false, match_count: 1, reason_codes };
      }
      if (rows.length > 1) {
        pushReason(reason_codes, "ambiguous_order_id_asin");
        return { row: null, matched_via: "order_id_asin", ambiguous: true, match_count: rows.length, reason_codes };
      }
    }
  }

  pushReason(reason_codes, "no_alternate_match");
  return { row: null, matched_via: "none", ambiguous: false, match_count: 0, reason_codes };
}

/**
 * Resolve `amazon_returns` row: exact id, then org + order_id + sku (hint may use amazon_order_id or order_id value), then org + lpn ilike.
 */
export async function resolveAmazonReturnsOperationalRow(
  client: SupabaseClient,
  organizationId: string,
  sourceRowId: string | null,
  hints: ReturnType<typeof mergeOperationalHints>,
): Promise<OperationalSourceResolve> {
  const reason_codes: string[] = [];
  const org = organizationId.trim();
  if (!org) {
    pushReason(reason_codes, "missing_organization_id");
    return { row: null, matched_via: "none", ambiguous: false, match_count: 0, reason_codes };
  }

  if (sourceRowId) {
    const { data, error } = await client
      .from("amazon_returns")
      .select("*")
      .eq("id", sourceRowId)
      .eq("organization_id", org)
      .maybeSingle();
    if (error) pushReason(reason_codes, `exact_id_query:${error.message}`);
    else if (data && typeof data === "object") {
      pushReason(reason_codes, "exact_id_hit");
      return {
        row: data as unknown as Record<string, unknown>,
        matched_via: "exact_id",
        ambiguous: false,
        match_count: 1,
        reason_codes,
      };
    }
    pushReason(reason_codes, "exact_id_miss");
  }

  const amzOrder = hints.amazon_order_id ?? hints.order_id;
  const sku = hints.sku;
  if (amzOrder && sku) {
    const { data, error } = await client
      .from("amazon_returns")
      .select("*")
      .eq("organization_id", org)
      .eq("order_id", amzOrder)
      .eq("sku", sku)
      .limit(8);
    if (!error) {
      const rows = (data ?? []) as unknown as Record<string, unknown>[];
      if (rows.length === 1) {
        pushReason(reason_codes, "alternate_hit_amazon_order_id_sku");
        return {
          row: rows[0]!,
          matched_via: "amazon_order_id_sku",
          ambiguous: false,
          match_count: 1,
          reason_codes,
        };
      }
      if (rows.length > 1) {
        pushReason(reason_codes, "ambiguous_amazon_order_id_sku");
        return {
          row: null,
          matched_via: "amazon_order_id_sku",
          ambiguous: true,
          match_count: rows.length,
          reason_codes,
        };
      }
    } else pushReason(reason_codes, `amazon_order_id_sku:${error.message}`);
  }

  const lpn = hints.lpn;
  if (lpn) {
    const { data, error } = await client
      .from("amazon_returns")
      .select("*")
      .eq("organization_id", org)
      .ilike("lpn", lpn)
      .limit(8);
    if (!error) {
      const rows = (data ?? []) as unknown as Record<string, unknown>[];
      if (rows.length === 1) {
        pushReason(reason_codes, "alternate_hit_lpn");
        return {
          row: rows[0]!,
          matched_via: "lpn_tracking",
          ambiguous: false,
          match_count: 1,
          reason_codes,
        };
      }
      if (rows.length > 1) {
        pushReason(reason_codes, "ambiguous_lpn");
        return { row: null, matched_via: "lpn_tracking", ambiguous: true, match_count: rows.length, reason_codes };
      }
    } else pushReason(reason_codes, `lpn:${error.message}`);
  }

  pushReason(reason_codes, "no_alternate_match");
  return { row: null, matched_via: "none", ambiguous: false, match_count: 0, reason_codes };
}

/** `return_items` (legacy name `returns`) — exact id + tenant scope; optional store_id when present on candidate. */
export async function resolveReturnsOperationalRow(
  client: SupabaseClient,
  organizationId: string,
  candidateStoreId: string | null,
  sourceRowId: string | null,
): Promise<OperationalSourceResolve> {
  const reason_codes: string[] = [];
  const org = organizationId.trim();
  if (!org || !sourceRowId) {
    pushReason(reason_codes, "missing_org_or_source_row_id");
    return { row: null, matched_via: "none", ambiguous: false, match_count: 0, reason_codes };
  }
  let q = client.from("return_items").select("*").eq("id", sourceRowId).eq("organization_id", org);
  const store = nv(candidateStoreId);
  if (store) q = q.eq("store_id", store);
  const { data, error } = await q.maybeSingle();
  if (error) {
    pushReason(reason_codes, `exact_id_query:${error.message}`);
    return { row: null, matched_via: "none", ambiguous: false, match_count: 0, reason_codes };
  }
  if (data && typeof data === "object") {
    pushReason(reason_codes, "exact_id_hit");
    return {
      row: data as unknown as Record<string, unknown>,
      matched_via: "exact_id",
      ambiguous: false,
      match_count: 1,
      reason_codes,
    };
  }
  pushReason(reason_codes, "exact_id_miss_return_items_no_alternate_in_claim13");
  return { row: null, matched_via: "none", ambiguous: false, match_count: 0, reason_codes };
}

export async function resolveAmazonRemovalShipmentsOperationalRow(
  client: SupabaseClient,
  organizationId: string,
  sourceRowId: string | null,
): Promise<OperationalSourceResolve> {
  const reason_codes: string[] = [];
  const org = organizationId.trim();
  if (!org || !sourceRowId) {
    pushReason(reason_codes, "missing_org_or_source_row_id");
    return { row: null, matched_via: "none", ambiguous: false, match_count: 0, reason_codes };
  }
  const { data, error } = await client
    .from("amazon_removal_shipments")
    .select("*")
    .eq("id", sourceRowId)
    .eq("organization_id", org)
    .maybeSingle();
  if (error) {
    pushReason(reason_codes, `exact_id_query:${error.message}`);
    return { row: null, matched_via: "none", ambiguous: false, match_count: 0, reason_codes };
  }
  if (data && typeof data === "object") {
    pushReason(reason_codes, "exact_id_hit");
    return {
      row: data as unknown as Record<string, unknown>,
      matched_via: "exact_id",
      ambiguous: false,
      match_count: 1,
      reason_codes,
    };
  }
  pushReason(reason_codes, "exact_id_miss_no_alternate_shipments_in_claim13");
  return { row: null, matched_via: "none", ambiguous: false, match_count: 0, reason_codes };
}
