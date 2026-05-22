/**
 * NEXT-CLAIM-19 — Defensive PostgREST column resolution for Claim Inbox reads.
 * SELECT-only probes; cached per process. No DB writes.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** Minimal columns required for resolver + inbox (matches dry-run core). */
const CLAIM_CANDIDATE_REQUIRED = [
  "id",
  "organization_id",
  "store_id",
  "source_table",
  "source_row_id",
  "resolved_product_id",
  "evidence_status",
  "sku",
  "fnsku",
  "asin",
  "created_at",
] as const;

/** Optional list columns — omitted if probe fails on this database. */
const CLAIM_CANDIDATE_OPTIONAL_LIST = [
  "product_id",
  "candidate_status",
  "claim_family",
  "claim_reason",
  "confidence_score",
] as const;

const CLAIM_CANDIDATE_OPTIONAL_DETAIL = [
  "updated_at",
  "order_id",
  "source_staging_id",
  "upload_id",
  "amazon_order_id",
  "lpn",
  "expected_units",
  "expected_amount",
] as const;

const PRODUCT_BADGE_REQUIRED = ["id", "organization_id", "title", "status", "asin", "fnsku", "seller_sku", "deleted_at"] as const;

const PRODUCT_BADGE_OPTIONAL = ["main_image_url", "catalog_product_id"] as const;

async function probeSelect(client: SupabaseClient, table: string, cols: string): Promise<boolean> {
  const { error } = await client.from(table).select(cols).limit(1);
  return !error;
}

let listSelectCache: string | null = null;
let listSelectInflight: Promise<string> | null = null;

let detailSelectCache: string | null = null;
let detailSelectInflight: Promise<string> | null = null;

let productBadgeCache: string | null = null;
let productBadgeInflight: Promise<string> | null = null;

/** Omitted optional list columns from last resolution (diagnostics). */
export let lastClaimCandidateListOmitted: string[] = [];
/** Omitted optional detail-only columns. */
export let lastClaimCandidateDetailExtraOmitted: string[] = [];
export let lastProductBadgeOmitted: string[] = [];

async function resolveListSelectInner(client: SupabaseClient): Promise<string> {
  lastClaimCandidateListOmitted = [];
  const cols: string[] = [...CLAIM_CANDIDATE_REQUIRED];
  for (const c of CLAIM_CANDIDATE_OPTIONAL_LIST) {
    if (await probeSelect(client, "claim_candidates", `id,${c}`)) cols.push(c);
    else lastClaimCandidateListOmitted.push(c);
  }
  return cols.join(", ");
}

async function resolveDetailExtrasInner(client: SupabaseClient): Promise<string> {
  lastClaimCandidateDetailExtraOmitted = [];
  const ok: string[] = [];
  for (const c of CLAIM_CANDIDATE_OPTIONAL_DETAIL) {
    if (await probeSelect(client, "claim_candidates", `id,${c}`)) ok.push(c);
    else lastClaimCandidateDetailExtraOmitted.push(c);
  }
  return ok.join(", ");
}

async function resolveProductBadgeInner(client: SupabaseClient): Promise<string> {
  lastProductBadgeOmitted = [];
  const cols: string[] = [...PRODUCT_BADGE_REQUIRED];
  for (const c of PRODUCT_BADGE_OPTIONAL) {
    if (await probeSelect(client, "products", `id,${c}`)) cols.push(c);
    else lastProductBadgeOmitted.push(c);
  }
  return cols.join(", ");
}

export async function getClaimInboxListSelect(client: SupabaseClient): Promise<string> {
  if (listSelectCache) return listSelectCache;
  if (listSelectInflight) return listSelectInflight;
  listSelectInflight = resolveListSelectInner(client).then((s) => {
    listSelectCache = s;
    listSelectInflight = null;
    return s;
  });
  return listSelectInflight;
}

export async function getClaimInboxDetailSelect(client: SupabaseClient): Promise<string> {
  if (detailSelectCache) return detailSelectCache;
  if (detailSelectInflight) return detailSelectInflight;
  detailSelectInflight = (async () => {
    const list = await getClaimInboxListSelect(client);
    const extras = await resolveDetailExtrasInner(client);
    const e = extras.trim();
    return e.length > 0 ? `${list}, ${e}` : list;
  })().then((s) => {
    detailSelectCache = s;
    detailSelectInflight = null;
    return s;
  });
  return detailSelectInflight;
}

export async function getClaimInboxProductBadgeSelect(client: SupabaseClient): Promise<string> {
  if (productBadgeCache) return productBadgeCache;
  if (productBadgeInflight) return productBadgeInflight;
  productBadgeInflight = resolveProductBadgeInner(client).then((s) => {
    productBadgeCache = s;
    productBadgeInflight = null;
    return s;
  });
  return productBadgeInflight;
}

/** Test-only reset for smoke scripts (same process multiple runs). */
export function resetClaimInboxSchemaCacheForTests(): void {
  listSelectCache = null;
  detailSelectCache = null;
  productBadgeCache = null;
}
