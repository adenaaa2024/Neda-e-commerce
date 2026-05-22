import * as fs from "node:fs";
import * as path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  classify,
  IDENTIFIER_TYPES,
  type ClassifyInput,
  type IdentifierMap,
  type LookupHit,
  type LookupResult,
} from "./product-seed-classifier";
import {
  extractFromAmazonAmazonFulfilledInventoryRow,
  extractFromAmazonFbaInventoryRow,
  extractFromAmazonManageFbaInventoryRow,
  type AmazonAmazonFulfilledInventoryRowProjection,
  type AmazonFbaInventoryRowProjection,
  type AmazonManageFbaInventoryRowProjection,
  type ExtractedIdentifiers,
} from "./product-seed-identifier-extract";
import {
  NDJsonWriter,
  mkRunId,
  sha256Hex,
  writeCsv,
  writeJson,
} from "./product-seed-output";
import { isUuidString } from "../uuid";

const PAGE_SIZE = 1000;
const DEFAULT_OUTPUT_BASE_DIR = path.join(".cursor", "audit-reports", "next-product-propagation");
const DEFAULT_NEXT_18M_BASE_DIR = path.join(".cursor", "audit-reports", "next-18m");

export const PHASE_1_PROPAGATION_TABLES = [
  "amazon_amazon_fulfilled_inventory",
  "amazon_manage_fba_inventory",
  "amazon_fba_inventory",
] as const;

export type Phase1PropagationTable = (typeof PHASE_1_PROPAGATION_TABLES)[number];

type SourceTableDescriptor = {
  name: Phase1PropagationTable;
  selectCols: string;
  uploadCol: "source_upload_id";
  extract: (row: Record<string, unknown>) => ExtractedIdentifiers;
  existingResolvedProductId: (row: Record<string, unknown>) => string | null;
  existingResolvedCatalogProductId: (row: Record<string, unknown>) => string | null;
};

const DESCRIPTORS: Record<Phase1PropagationTable, SourceTableDescriptor> = {
  amazon_amazon_fulfilled_inventory: {
    name: "amazon_amazon_fulfilled_inventory",
    selectCols:
      "id, organization_id, store_id, seller_sku, fulfillment_channel_sku, asin, resolved_product_id, resolved_catalog_product_id, source_upload_id, raw_data",
    uploadCol: "source_upload_id",
    extract: (row) =>
      extractFromAmazonAmazonFulfilledInventoryRow(
        row as unknown as AmazonAmazonFulfilledInventoryRowProjection,
      ),
    existingResolvedProductId: (row) => nonEmptyString(row.resolved_product_id),
    existingResolvedCatalogProductId: (row) => nonEmptyString(row.resolved_catalog_product_id),
  },
  amazon_manage_fba_inventory: {
    name: "amazon_manage_fba_inventory",
    selectCols:
      "id, organization_id, store_id, sku, fnsku, asin, product_name, resolved_product_id, resolved_catalog_product_id, source_upload_id, raw_data",
    uploadCol: "source_upload_id",
    extract: (row) =>
      extractFromAmazonManageFbaInventoryRow(row as unknown as AmazonManageFbaInventoryRowProjection),
    existingResolvedProductId: (row) => nonEmptyString(row.resolved_product_id),
    existingResolvedCatalogProductId: (row) => nonEmptyString(row.resolved_catalog_product_id),
  },
  amazon_fba_inventory: {
    name: "amazon_fba_inventory",
    selectCols:
      "id, organization_id, store_id, sku, fnsku, asin, product_name, resolved_product_id, resolved_catalog_product_id, source_upload_id, raw_data",
    uploadCol: "source_upload_id",
    extract: (row) => extractFromAmazonFbaInventoryRow(row as unknown as AmazonFbaInventoryRowProjection),
    existingResolvedProductId: (row) => nonEmptyString(row.resolved_product_id),
    existingResolvedCatalogProductId: (row) => nonEmptyString(row.resolved_catalog_product_id),
  },
};

type IdentifierMapRowMin = {
  id: string;
  product_id: string | null;
  catalog_product_id?: string | null;
  seller_sku: string | null;
  asin: string | null;
  fnsku: string | null;
  msku?: string | null;
  upc_code: string | null;
  store_id: string | null;
  match_source: string | null;
};

type ProductsRowMin = {
  id: string;
  sku: string | null;
  asin: string | null;
  fnsku: string | null;
  upc_code: string | null;
  store_id: string | null;
  merge_status: string | null;
};

type CatalogHitIndexValue = {
  productId: string;
  catalogProductId: string | null;
};

class TenantIndex {
  private mapBySellerSku = new Map<string, LookupHit[]>();
  private mapByAsin = new Map<string, LookupHit[]>();
  private mapByFnsku = new Map<string, LookupHit[]>();
  private mapByUpc = new Map<string, LookupHit[]>();
  private productsBySku = new Map<string, LookupHit[]>();
  private productsByAsin = new Map<string, LookupHit[]>();
  private productsByFnsku = new Map<string, LookupHit[]>();
  private productsByUpc = new Map<string, LookupHit[]>();
  private uploadIdSet = new Set<string>();
  private catalogByProductId = new Map<string, CatalogHitIndexValue>();

  constructor(
    readonly organizationId: string,
    readonly storeId: string | null,
  ) {}

  ingestMapRow(row: IdentifierMapRowMin): void {
    const hit: LookupHit = {
      product_id: row.product_id,
      source_id: row.id,
      match_source: row.match_source,
      store_scope: row.store_id ? "store" : "org",
    };
    const sellerSku = nonEmptyString(row.seller_sku) ?? nonEmptyString(row.msku);
    if (sellerSku) push(this.mapBySellerSku, sellerSku, hit);
    if (row.asin) push(this.mapByAsin, row.asin.toUpperCase(), hit);
    if (row.fnsku) push(this.mapByFnsku, row.fnsku.toUpperCase(), hit);
    if (row.upc_code) push(this.mapByUpc, row.upc_code, hit);
    if (row.product_id && !this.catalogByProductId.has(row.product_id)) {
      this.catalogByProductId.set(row.product_id, {
        productId: row.product_id,
        catalogProductId: nonEmptyString(row.catalog_product_id),
      });
    }
  }

  ingestProductsRow(row: ProductsRowMin): void {
    if (row.merge_status === "merged") return;
    const hit: LookupHit = {
      product_id: row.id,
      source_id: row.id,
      match_source: "products_direct",
      store_scope: row.store_id ? "store" : "org",
    };
    if (row.sku) push(this.productsBySku, row.sku, hit);
    if (row.asin) push(this.productsByAsin, row.asin.toUpperCase(), hit);
    if (row.fnsku) push(this.productsByFnsku, row.fnsku.toUpperCase(), hit);
    if (row.upc_code) push(this.productsByUpc, row.upc_code, hit);
  }

  ingestUploadIds(ids: string[]): void {
    for (const id of ids) {
      if (id) this.uploadIdSet.add(id);
    }
  }

  lookup(identifiers: IdentifierMap): {
    identifierMapHits: LookupResult;
    productsHits: LookupResult;
    productsCollisionSku: boolean;
  } {
    const identifierMapHits: LookupResult = {};
    const productsDirect: LookupResult["products_direct"] = {};
    if (identifiers.seller_sku) {
      identifierMapHits.seller_sku = this.mapBySellerSku.get(identifiers.seller_sku) ?? [];
      productsDirect.seller_sku = this.productsBySku.get(identifiers.seller_sku) ?? [];
    }
    if (identifiers.asin) {
      identifierMapHits.asin = this.mapByAsin.get(identifiers.asin) ?? [];
      productsDirect.asin = this.productsByAsin.get(identifiers.asin) ?? [];
    }
    if (identifiers.fnsku) {
      identifierMapHits.fnsku = this.mapByFnsku.get(identifiers.fnsku) ?? [];
      productsDirect.fnsku = this.productsByFnsku.get(identifiers.fnsku) ?? [];
    }
    if (identifiers.upc) {
      identifierMapHits.upc = this.mapByUpc.get(identifiers.upc) ?? [];
      productsDirect.upc = this.productsByUpc.get(identifiers.upc) ?? [];
    }
    return {
      identifierMapHits,
      productsHits: { products_direct: productsDirect },
      productsCollisionSku: (productsDirect.seller_sku?.length ?? 0) > 0,
    };
  }

  uploadResolved(uploadId: string | null): boolean {
    return !!uploadId && this.uploadIdSet.has(uploadId);
  }

  catalogProductIdFor(productId: string | null): string | null {
    if (!productId) return null;
    return this.catalogByProductId.get(productId)?.catalogProductId ?? null;
  }
}

type DisputeHit = {
  dispute_id: string;
  taxonomy_cell: string;
  secondary_cells: string[];
  block_reasons: string[];
  hot_loser_flag: boolean;
};

type DisputeOverlay = {
  inputDir: string | null;
  records: number;
  c1c4Records: number;
  productIds: Set<string>;
  hitsByProductId: Map<string, DisputeHit[]>;
};

export type PropagationOutcome =
  | "already_resolved"
  | "eligible_existing_bridge_match"
  | "blocked_next_18m_dispute"
  | "blocked_ambiguous_conflict"
  | "blocked_dirty_identifier"
  | "blocked_missing_lineage"
  | "blocked_title_only_or_weak_only"
  | "blocked_product_creation_required"
  | "manual_review_required";

export type PropagationRow = {
  run_id: string;
  source_table: Phase1PropagationTable;
  source_row_id: string | null;
  organization_id: string | null;
  store_id: string | null;
  source_upload_id: string | null;
  upload_provenance_resolved: boolean;
  native_sku: string | null;
  native_seller_sku: string | null;
  native_fnsku: string | null;
  native_fulfillment_channel_sku: string | null;
  native_asin: string | null;
  native_title: string | null;
  normalized_identifier_signature: string;
  existing_resolved_product_id: string | null;
  existing_resolved_catalog_product_id: string | null;
  candidate_product_ids: string[];
  recommended_product_id: string | null;
  recommended_catalog_product_id: string | null;
  outcome: PropagationOutcome;
  classifier_bucket_id: number;
  classifier_bucket_label: string;
  primary_reason: string;
  secondary_reasons: string[];
  block_reasons: string[];
  next_18m_dispute_ids: string[];
  next_18m_taxonomy_cells: string[];
  confidence_band: "already_resolved" | "high" | "medium" | "review" | "blocked";
  match_rank: number | null;
  would_write: boolean;
  would_review: boolean;
  would_create_product: boolean;
  blocked_by_dispute: boolean;
  hypothetical_update: {
    resolved_product_id: string | null;
    resolved_catalog_product_id: string | null;
    identifier_resolution_status: string | null;
    identifier_resolution_confidence: number | null;
  };
};

type ValidationCheck = {
  name: string;
  pass: boolean;
  strict: true;
  note: string;
};

type TableSummary = {
  source_table: Phase1PropagationTable;
  source_count: number;
  rows_analyzed: number;
  already_resolved: number;
  would_write: number;
  would_review: number;
  would_create_product: number;
  blocked_by_dispute: number;
};

export type ProductPropagationDryRunResult = {
  runId: string;
  runDir: string;
  rowsAnalyzedByTable: Record<Phase1PropagationTable, number>;
  wouldWriteCount: number;
  wouldReviewCount: number;
  blockedByDisputeCount: number;
  currentBlockers: string[];
  validationChecks: ValidationCheck[];
};

export type ProductPropagationDryRunOptions = {
  supabase: SupabaseClient;
  outputBaseDir?: string | null;
  runId?: string | null;
  organizationId?: string | null;
  storeId?: string | null;
  maxRowsPerTable?: number | null;
  next18mDir?: string | null;
  envHashInput?: string | null;
  supabaseJsVersion?: string | null;
  generatorGitSha?: string | null;
  cliArgs?: Record<string, string | number | boolean | null>;
};

type TenantPair = { organizationId: string; storeId: string | null };

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

function nonEmptyString(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function latestRunDir(baseDir: string, requiredFile: string): string | null {
  if (!fs.existsSync(baseDir)) return null;
  const candidates = fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(baseDir, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, requiredFile)))
    .sort();
  return candidates[candidates.length - 1] ?? null;
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)).filter(Boolean) : [];
}

function readNext18MDisputeOverlay(inputDir: string | null | undefined): DisputeOverlay {
  const dir = inputDir ?? latestRunDir(DEFAULT_NEXT_18M_BASE_DIR, "01-dispute-candidates.ndjson");
  const empty: DisputeOverlay = {
    inputDir: dir,
    records: 0,
    c1c4Records: 0,
    productIds: new Set(),
    hitsByProductId: new Map(),
  };
  if (!dir) return empty;
  const file = path.join(dir, "01-dispute-candidates.ndjson");
  if (!fs.existsSync(file)) return empty;

  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed) as unknown as Record<string, unknown>;
    } catch {
      continue;
    }
    empty.records += 1;
    const taxonomy = nonEmptyString(row.taxonomy_cell) ?? "";
    if (taxonomy !== "C1" && taxonomy !== "C4") continue;
    empty.c1c4Records += 1;

    const hit: DisputeHit = {
      dispute_id: nonEmptyString(row.dispute_id) ?? "(missing)",
      taxonomy_cell: taxonomy,
      secondary_cells: parseStringArray(row.secondary_cells),
      block_reasons: parseStringArray(row.block_reasons),
      hot_loser_flag: row.hot_loser_flag === true,
    };
    const ids = new Set<string>();
    for (const member of parseStringArray(row.members)) ids.add(member);
    const orphanId = nonEmptyString(row.orphan_id);
    const winnerId = nonEmptyString(row.recommended_winner_id);
    if (orphanId) ids.add(orphanId);
    if (winnerId) ids.add(winnerId);

    for (const productId of ids) {
      if (!isUuidString(productId)) continue;
      empty.productIds.add(productId);
      push(empty.hitsByProductId, productId, hit);
    }
  }
  return empty;
}

async function loadIdentifierMapIndex(
  supabase: SupabaseClient,
  index: TenantIndex,
): Promise<number> {
  let from = 0;
  let total = 0;
  for (;;) {
    let query = supabase
      .from("product_identifier_map")
      .select("id, product_id, catalog_product_id, seller_sku, asin, fnsku, msku, upc_code, store_id, match_source, deleted_at")
      .eq("organization_id", index.organizationId)
      .is("deleted_at", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (index.storeId) query = query.or(`store_id.eq.${index.storeId},store_id.is.null`);
    const { data, error } = await query;
    if (error) throw new Error(`product_identifier_map read failed: ${error.message}`);
    const rows = (data ?? []) as IdentifierMapRowMin[];
    for (const row of rows) index.ingestMapRow(row);
    total += rows.length;
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return total;
}

async function loadProductsIndex(
  supabase: SupabaseClient,
  index: TenantIndex,
): Promise<number> {
  let from = 0;
  let total = 0;
  for (;;) {
    let query = supabase
      .from("products")
      .select("id, sku, asin, fnsku, upc_code, store_id, merge_status, deleted_at")
      .eq("organization_id", index.organizationId)
      .is("deleted_at", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (index.storeId) query = query.or(`store_id.eq.${index.storeId},store_id.is.null`);
    const { data, error } = await query;
    if (error) throw new Error(`products read failed: ${error.message}`);
    const rows = (data ?? []) as Array<ProductsRowMin & { deleted_at: string | null }>;
    for (const row of rows) index.ingestProductsRow(row);
    total += rows.length;
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return total;
}

async function loadUploadProvenanceIndex(
  supabase: SupabaseClient,
  index: TenantIndex,
): Promise<number> {
  let from = 0;
  let total = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("raw_report_uploads")
      .select("id")
      .eq("organization_id", index.organizationId)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`raw_report_uploads read failed: ${error.message}`);
    const rows = (data ?? []) as Array<{ id: string }>;
    index.ingestUploadIds(rows.map((row) => String(row.id ?? "")));
    total += rows.length;
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return total;
}

async function discoverOrgStorePairs(
  supabase: SupabaseClient,
  tableName: Phase1PropagationTable,
  orgFilter: string | null,
  storeFilter: string | null,
): Promise<TenantPair[]> {
  const seen = new Map<string, TenantPair>();
  let from = 0;
  for (;;) {
    let query = supabase
      .from(tableName)
      .select("organization_id, store_id")
      .order("organization_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (orgFilter) query = query.eq("organization_id", orgFilter);
    if (storeFilter) query = query.eq("store_id", storeFilter);
    const { data, error } = await query;
    if (error) throw new Error(`${tableName} discovery read failed: ${error.message}`);
    const rows = (data ?? []) as Array<{ organization_id: string | null; store_id: string | null }>;
    for (const row of rows) {
      const organizationId = nonEmptyString(row.organization_id);
      if (!organizationId) continue;
      const storeId = nonEmptyString(row.store_id);
      const key = `${organizationId}|${storeId ?? "null"}`;
      if (!seen.has(key)) seen.set(key, { organizationId, storeId });
    }
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return [...seen.values()];
}

async function countSourceRows(
  supabase: SupabaseClient,
  tableName: Phase1PropagationTable,
  orgFilter: string | null,
  storeFilter: string | null,
): Promise<number> {
  let query = supabase
    .from(tableName)
    .select("id", { count: "exact", head: true });
  if (orgFilter) query = query.eq("organization_id", orgFilter);
  if (storeFilter) query = query.eq("store_id", storeFilter);
  const { count, error } = await query;
  if (error) throw new Error(`${tableName} count read failed: ${error.message}`);
  return count ?? 0;
}

function nativeIdentifiers(row: Record<string, unknown>): Pick<
  PropagationRow,
  "native_sku" | "native_seller_sku" | "native_fnsku" | "native_fulfillment_channel_sku" | "native_asin" | "native_title"
> {
  return {
    native_sku: nonEmptyString(row.sku),
    native_seller_sku: nonEmptyString(row.seller_sku),
    native_fnsku: nonEmptyString(row.fnsku),
    native_fulfillment_channel_sku: nonEmptyString(row.fulfillment_channel_sku),
    native_asin: nonEmptyString(row.asin),
    native_title: nonEmptyString(row.product_name),
  };
}

function identifierSignature(identifiers: IdentifierMap): string {
  const parts: string[] = [];
  for (const key of [...IDENTIFIER_TYPES, "title"] as const) {
    const value = identifiers[key];
    if (value) parts.push(`${key}:${value}`);
  }
  return parts.length > 0 ? parts.join("|") : "(none)";
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value))].sort();
}

function disputeHitsFor(overlay: DisputeOverlay, productIds: string[]): DisputeHit[] {
  const byId = new Map<string, DisputeHit>();
  for (const productId of productIds) {
    for (const hit of overlay.hitsByProductId.get(productId) ?? []) {
      byId.set(hit.dispute_id, hit);
    }
  }
  return [...byId.values()];
}

function classifyOutcome(args: {
  bucketId: number;
  blockedByDispute: boolean;
  lineageResolved: boolean;
  recommendedProductId: string | null;
}): PropagationOutcome {
  if (args.bucketId === 1) return "already_resolved";
  if (args.blockedByDispute) return "blocked_next_18m_dispute";
  if (!args.lineageResolved) return "blocked_missing_lineage";
  if ((args.bucketId === 2 || args.bucketId === 3) && args.recommendedProductId) {
    return "eligible_existing_bridge_match";
  }
  if (args.bucketId === 4) return "blocked_product_creation_required";
  if (args.bucketId === 5) return "blocked_ambiguous_conflict";
  if (args.bucketId === 10) return "blocked_dirty_identifier";
  if (args.bucketId === 6 || args.bucketId === 7) return "blocked_title_only_or_weak_only";
  return "manual_review_required";
}

function confidenceBand(row: {
  outcome: PropagationOutcome;
  matchRank: number | null;
}): PropagationRow["confidence_band"] {
  if (row.outcome === "already_resolved") return "already_resolved";
  if (row.outcome.startsWith("blocked_")) return "blocked";
  if (row.outcome !== "eligible_existing_bridge_match") return "review";
  if (row.matchRank === 2 || row.matchRank === 3 || row.matchRank === 4) return "high";
  return "medium";
}

function rowToCsv(row: PropagationRow): Record<string, unknown> {
  return {
    run_id: row.run_id,
    source_table: row.source_table,
    source_row_id: row.source_row_id,
    organization_id: row.organization_id,
    store_id: row.store_id,
    source_upload_id: row.source_upload_id,
    upload_provenance_resolved: row.upload_provenance_resolved,
    native_sku: row.native_sku,
    native_seller_sku: row.native_seller_sku,
    native_fnsku: row.native_fnsku,
    native_fulfillment_channel_sku: row.native_fulfillment_channel_sku,
    native_asin: row.native_asin,
    native_title: row.native_title,
    normalized_identifier_signature: row.normalized_identifier_signature,
    existing_resolved_product_id: row.existing_resolved_product_id,
    candidate_product_ids: row.candidate_product_ids.join("|"),
    recommended_product_id: row.recommended_product_id,
    outcome: row.outcome,
    classifier_bucket_label: row.classifier_bucket_label,
    primary_reason: row.primary_reason,
    block_reasons: row.block_reasons.join("|"),
    next_18m_dispute_ids: row.next_18m_dispute_ids.join("|"),
    confidence_band: row.confidence_band,
    match_rank: row.match_rank,
    would_write: row.would_write,
    would_review: row.would_review,
    would_create_product: row.would_create_product,
    blocked_by_dispute: row.blocked_by_dispute,
  };
}

const PROPAGATION_ROW_HEADERS = [
  "run_id",
  "source_table",
  "source_row_id",
  "organization_id",
  "store_id",
  "source_upload_id",
  "upload_provenance_resolved",
  "native_sku",
  "native_seller_sku",
  "native_fnsku",
  "native_fulfillment_channel_sku",
  "native_asin",
  "native_title",
  "normalized_identifier_signature",
  "existing_resolved_product_id",
  "candidate_product_ids",
  "recommended_product_id",
  "outcome",
  "classifier_bucket_label",
  "primary_reason",
  "block_reasons",
  "next_18m_dispute_ids",
  "confidence_band",
  "match_rank",
  "would_write",
  "would_review",
  "would_create_product",
  "blocked_by_dispute",
] as const;

async function processTenantTable(args: {
  supabase: SupabaseClient;
  descriptor: SourceTableDescriptor;
  index: TenantIndex;
  runId: string;
  overlay: DisputeOverlay;
  maxRowsPerTable: number | null;
  rows: PropagationRow[];
  decisionTrace: NDJsonWriter;
  crossTenantLeakage: { count: number };
}): Promise<number> {
  const {
    supabase,
    descriptor,
    index,
    runId,
    overlay,
    maxRowsPerTable,
    rows: outRows,
    decisionTrace,
    crossTenantLeakage,
  } = args;
  let from = 0;
  let processed = 0;
  const limit = maxRowsPerTable ?? Number.POSITIVE_INFINITY;
  for (;;) {
    if (processed >= limit) break;
    let query = supabase
      .from(descriptor.name)
      .select(descriptor.selectCols)
      .eq("organization_id", index.organizationId)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (index.storeId) query = query.eq("store_id", index.storeId);
    else query = query.is("store_id", null);

    const { data, error } = await query;
    if (error) throw new Error(`${descriptor.name} read failed: ${error.message}`);
    const sourceRows = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (sourceRows.length === 0) break;

    for (const sourceRow of sourceRows) {
      if (processed >= limit) break;
      processed += 1;
      const organizationId = nonEmptyString(sourceRow.organization_id);
      const storeId = nonEmptyString(sourceRow.store_id);
      if (organizationId !== index.organizationId || (storeId ?? null) !== index.storeId) {
        crossTenantLeakage.count += 1;
      }

      const extracted = descriptor.extract(sourceRow);
      const sourceUploadId = nonEmptyString(sourceRow[descriptor.uploadCol]);
      const uploadResolved = index.uploadResolved(sourceUploadId);
      const lookups = index.lookup(extracted.identifiers);
      const existingResolvedProductId = descriptor.existingResolvedProductId(sourceRow);
      const existingResolvedCatalogProductId = descriptor.existingResolvedCatalogProductId(sourceRow);
      const rowAlreadyResolved = !!(existingResolvedProductId && isUuidString(existingResolvedProductId));

      const input: ClassifyInput = {
        sourceTable: descriptor.name,
        rowAlreadyResolved,
        existingResolvedProductId: rowAlreadyResolved ? existingResolvedProductId : null,
        existingResolvedCatalogProductId,
        orgId: organizationId,
        storeId,
        identifiers: extracted.identifiers,
        identifierSources: extracted.identifierSources,
        shape: extracted.shape,
        identifierMapHits: lookups.identifierMapHits,
        productsHits: lookups.productsHits,
        productsCollisionSku: lookups.productsCollisionSku,
        uploadResolved,
      };
      const classified = classify(input);
      const recommendedProductId =
        classified.bucketId === 2 || classified.bucketId === 3
          ? classified.existingProductIdHit
          : null;
      const candidateProductIds = uniqueStrings([
        recommendedProductId,
        classified.existingProductIdHit,
        ...classified.conflictProductIds,
      ]);
      const disputeHits = disputeHitsFor(overlay, candidateProductIds);
      const blockedByDispute = disputeHits.length > 0 && !rowAlreadyResolved;
      const lineageResolved = !!sourceUploadId && uploadResolved;
      const outcome = classifyOutcome({
        bucketId: classified.bucketId,
        blockedByDispute,
        lineageResolved,
        recommendedProductId,
      });
      const wouldWrite =
        outcome === "eligible_existing_bridge_match" &&
        !!recommendedProductId &&
        !rowAlreadyResolved;
      const wouldCreateProduct = classified.bucketId === 4;
      const wouldReview = !wouldWrite && outcome !== "already_resolved";
      const recommendedCatalogProductId = index.catalogProductIdFor(recommendedProductId);
      const disputeIds = disputeHits.map((hit) => hit.dispute_id).sort();
      const disputeTaxonomy = uniqueStrings(disputeHits.map((hit) => hit.taxonomy_cell));
      const blockReasons = uniqueStrings([
        ...(blockedByDispute ? ["next_18m_c1_c4_dispute"] : []),
        ...(!lineageResolved && outcome !== "already_resolved" ? ["missing_or_unresolved_upload_lineage"] : []),
        ...(wouldCreateProduct ? ["product_creation_out_of_scope"] : []),
        ...(classified.bucketId === 5 ? ["ambiguous_conflict"] : []),
        ...(classified.bucketId === 10 ? ["dirty_identifier"] : []),
        ...(classified.bucketId === 6 || classified.bucketId === 7 ? ["weak_only_match"] : []),
        ...classified.secondaryReasons,
      ]);

      const row: PropagationRow = {
        run_id: runId,
        source_table: descriptor.name,
        source_row_id: nonEmptyString(sourceRow.id),
        organization_id: organizationId,
        store_id: storeId,
        source_upload_id: sourceUploadId,
        upload_provenance_resolved: uploadResolved,
        ...nativeIdentifiers(sourceRow),
        normalized_identifier_signature: identifierSignature(extracted.identifiers),
        existing_resolved_product_id: existingResolvedProductId,
        existing_resolved_catalog_product_id: existingResolvedCatalogProductId,
        candidate_product_ids: candidateProductIds,
        recommended_product_id: recommendedProductId,
        recommended_catalog_product_id: recommendedCatalogProductId,
        outcome,
        classifier_bucket_id: classified.bucketId,
        classifier_bucket_label: classified.bucketLabel,
        primary_reason: classified.primaryReason,
        secondary_reasons: classified.secondaryReasons,
        block_reasons: blockReasons,
        next_18m_dispute_ids: disputeIds,
        next_18m_taxonomy_cells: disputeTaxonomy,
        confidence_band: confidenceBand({ outcome, matchRank: classified.matchRank }),
        match_rank: classified.matchRank,
        would_write: wouldWrite,
        would_review: wouldReview,
        would_create_product: wouldCreateProduct,
        blocked_by_dispute: blockedByDispute,
        hypothetical_update: wouldWrite
          ? {
              resolved_product_id: recommendedProductId,
              resolved_catalog_product_id: recommendedCatalogProductId,
              identifier_resolution_status: "resolved",
              identifier_resolution_confidence: rowConfidence(classified.matchRank),
            }
          : {
              resolved_product_id: null,
              resolved_catalog_product_id: null,
              identifier_resolution_status: null,
              identifier_resolution_confidence: null,
            },
      };
      outRows.push(row);
      decisionTrace.write({
        run_id: runId,
        source_table: row.source_table,
        source_row_id: row.source_row_id,
        classifier_bucket: row.classifier_bucket_label,
        outcome: row.outcome,
        would_write: row.would_write,
        would_review: row.would_review,
        blocked_by_dispute: row.blocked_by_dispute,
        candidate_product_ids: row.candidate_product_ids,
        next_18m_dispute_ids: row.next_18m_dispute_ids,
        block_reasons: row.block_reasons,
      });
    }
    if (sourceRows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return processed;
}

function rowConfidence(matchRank: number | null): number | null {
  switch (matchRank) {
    case 2:
      return 0.95;
    case 3:
      return 0.85;
    case 4:
      return 0.9;
    case 8:
      return 0.7;
    default:
      return null;
  }
}

function summarizeTables(
  rows: PropagationRow[],
  sourceCounts: Record<Phase1PropagationTable, number>,
): TableSummary[] {
  return PHASE_1_PROPAGATION_TABLES.map((table) => {
    const tableRows = rows.filter((row) => row.source_table === table);
    return {
      source_table: table,
      source_count: sourceCounts[table],
      rows_analyzed: tableRows.length,
      already_resolved: tableRows.filter((row) => row.outcome === "already_resolved").length,
      would_write: tableRows.filter((row) => row.would_write).length,
      would_review: tableRows.filter((row) => row.would_review).length,
      would_create_product: tableRows.filter((row) => row.would_create_product).length,
      blocked_by_dispute: tableRows.filter((row) => row.blocked_by_dispute).length,
    };
  });
}

function buildValidationChecks(args: {
  rows: PropagationRow[];
  tableSummary: TableSummary[];
  crossTenantLeakageCount: number;
  disputeProductIds: Set<string>;
}): ValidationCheck[] {
  const p2Failures = args.rows.filter((row) => row.would_write && row.would_review).length;
  const p3Failures = args.rows.filter(
    (row) => row.would_write && !!row.recommended_product_id && args.disputeProductIds.has(row.recommended_product_id),
  ).length;
  const p4Failures = args.rows.filter((row) => row.would_write && row.outcome === "already_resolved").length;
  const p5Failures = args.tableSummary.filter((entry) => entry.source_count !== entry.rows_analyzed).length;
  return [
    {
      name: "P1_zero_cross_tenant_leakage",
      pass: args.crossTenantLeakageCount === 0,
      strict: true,
      note: `cross_tenant_leakage_count=${args.crossTenantLeakageCount}`,
    },
    {
      name: "P2_would_write_implies_would_review_false",
      pass: p2Failures === 0,
      strict: true,
      note: `violations=${p2Failures}`,
    },
    {
      name: "P3_no_would_write_for_next_18m_c1_c4_dispute_product_ids",
      pass: p3Failures === 0,
      strict: true,
      note: `violations=${p3Failures}`,
    },
    {
      name: "P4_already_resolved_rows_excluded_from_write_cohort",
      pass: p4Failures === 0,
      strict: true,
      note: `violations=${p4Failures}`,
    },
    {
      name: "P5_per_table_row_count_matches_source_select_scope",
      pass: p5Failures === 0,
      strict: true,
      note: `table_count_mismatches=${p5Failures}`,
    },
  ];
}

function writeValidationMarkdown(
  runDir: string,
  checks: ValidationCheck[],
  tableSummary: TableSummary[],
): void {
  const lines = [
    "# Validation Results",
    "",
    "## P1-P5",
    "",
    "| Check | Pass | Note |",
    "| --- | --- | --- |",
    ...checks.map((check) => `| ${check.name} | ${check.pass ? "PASS" : "FAIL"} | ${check.note} |`),
    "",
    "## Table Counts",
    "",
    "| Table | Source count | Rows analyzed | Would write | Would review | Blocked by dispute |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...tableSummary.map(
      (entry) =>
        `| ${entry.source_table} | ${entry.source_count} | ${entry.rows_analyzed} | ${entry.would_write} | ${entry.would_review} | ${entry.blocked_by_dispute} |`,
    ),
    "",
  ];
  fs.writeFileSync(path.join(runDir, "validation-results.md"), lines.join("\n"), "utf8");
}

function writeNextStepRecommendation(runDir: string, checks: ValidationCheck[]): void {
  const allPass = checks.every((check) => check.pass);
  const body = `# Next-Step Recommendation

## Recommended next

${allPass
    ? "**NEXT-PRODUCT-21 — Phase 1 propagation review pack and owner signoff (read-only).**"
    : "**Stop and fix failed P-checks before any propagation review or writeback package.**"}

## Scope

- Review \`03-would-review.csv\`, \`04-would-create-product.csv\`, and \`05-blocked-by-dispute.csv\`.
- Do not write \`product_id\`, \`resolved_product_id\`, products, or \`product_identifier_map\`.
- Any future writeback must be a separate exact-PK package with preimage and rollback preview.

## Exact next prompt

\`\`\`text
NEXT-PRODUCT-21 — PHASE 1 PROPAGATION REVIEW PACK (READ-ONLY)

Use the latest NEXT-PRODUCT-20 dry-run output.
Summarize would_write, would_review, would_create_product, and blocked-by-dispute rows.
Produce owner signoff artifacts for Phase 1 only.
No writes.
No migrations.
No product creation.
No product_id or resolved_product_id writes.
No product_identifier_map writes.
No AI/OpenAI.
No external APIs.
\`\`\`
`;
  fs.writeFileSync(path.join(runDir, "next-step-recommendation.md"), body, "utf8");
}

function currentBlockers(rows: PropagationRow[], checks: ValidationCheck[]): string[] {
  const blockers: string[] = [];
  const disputeCount = rows.filter((row) => row.blocked_by_dispute).length;
  const reviewCount = rows.filter((row) => row.would_review).length;
  const createCount = rows.filter((row) => row.would_create_product).length;
  const failedChecks = checks.filter((check) => !check.pass).map((check) => check.name);
  if (disputeCount > 0) blockers.push(`${disputeCount} row(s) blocked by NEXT-18M C1/C4 dispute overlay`);
  if (reviewCount > 0) blockers.push(`${reviewCount} row(s) require review before any future writeback`);
  if (createCount > 0) blockers.push(`${createCount} row(s) would require product creation, which is out of scope`);
  if (failedChecks.length > 0) blockers.push(`Failed validation checks: ${failedChecks.join(", ")}`);
  return blockers;
}

export async function runProductPropagationDryRun(
  options: ProductPropagationDryRunOptions,
): Promise<ProductPropagationDryRunResult> {
  const runId = options.runId ?? mkRunId();
  const outputBaseDir = options.outputBaseDir ?? DEFAULT_OUTPUT_BASE_DIR;
  const runDir = path.join(outputBaseDir, runId);
  ensureDir(runDir);
  ensureDir(path.join(runDir, "logs"));

  const startedAt = new Date().toISOString();
  const overlay = readNext18MDisputeOverlay(options.next18mDir);
  const decisionTrace = new NDJsonWriter(path.join(runDir, "logs", "decision-trace.ndjson"));
  const rows: PropagationRow[] = [];
  const crossTenantLeakage = { count: 0 };
  const sourceCounts = Object.fromEntries(
    PHASE_1_PROPAGATION_TABLES.map((table) => [table, 0]),
  ) as Record<Phase1PropagationTable, number>;

  for (const table of PHASE_1_PROPAGATION_TABLES) {
    sourceCounts[table] = await countSourceRows(
      options.supabase,
      table,
      options.organizationId ?? null,
      options.storeId ?? null,
    );
  }

  const pairMap = new Map<string, TenantPair>();
  for (const table of PHASE_1_PROPAGATION_TABLES) {
    const pairs = await discoverOrgStorePairs(
      options.supabase,
      table,
      options.organizationId ?? null,
      options.storeId ?? null,
    );
    for (const pair of pairs) {
      pairMap.set(`${pair.organizationId}|${pair.storeId ?? "null"}`, pair);
    }
  }

  const tableProcessed = Object.fromEntries(
    PHASE_1_PROPAGATION_TABLES.map((table) => [table, 0]),
  ) as Record<Phase1PropagationTable, number>;
  const indexLoadStats: Array<Record<string, unknown>> = [];

  for (const pair of pairMap.values()) {
    const index = new TenantIndex(pair.organizationId, pair.storeId);
    const [mapRows, productRows, uploadRows] = await Promise.all([
      loadIdentifierMapIndex(options.supabase, index),
      loadProductsIndex(options.supabase, index),
      loadUploadProvenanceIndex(options.supabase, index),
    ]);
    indexLoadStats.push({
      organization_id: pair.organizationId,
      store_id: pair.storeId,
      product_identifier_map_rows: mapRows,
      products_rows: productRows,
      raw_report_upload_rows: uploadRows,
    });

    for (const table of PHASE_1_PROPAGATION_TABLES) {
      const processed = await processTenantTable({
        supabase: options.supabase,
        descriptor: DESCRIPTORS[table],
        index,
        runId,
        overlay,
        maxRowsPerTable: options.maxRowsPerTable ?? null,
        rows,
        decisionTrace,
        crossTenantLeakage,
      });
      tableProcessed[table] += processed;
    }
  }

  await decisionTrace.close();

  const tableSummary = summarizeTables(rows, sourceCounts);
  const checks = buildValidationChecks({
    rows,
    tableSummary,
    crossTenantLeakageCount: crossTenantLeakage.count,
    disputeProductIds: overlay.productIds,
  });
  const blockers = currentBlockers(rows, checks);
  const finishedAt = new Date().toISOString();
  const allRowsCsv = rows.map(rowToCsv);

  writeJson(path.join(runDir, "manifest.json"), {
    prompt: "NEXT-PRODUCT-20",
    title: "Propagation Dry-Run Orchestrator Read-Only",
    run_id: runId,
    started_at: startedAt,
    finished_at: finishedAt,
    output_directory: runDir,
    artifact_only: true,
    no_write_guards: {
      no_product_id_writes: true,
      no_resolved_product_id_writes: true,
      no_product_creation: true,
      no_product_identifier_map_writes: true,
      no_product_graph_mutation: true,
      no_migrations: true,
      no_ai_or_openai_calls: true,
      no_external_api_calls: true,
    },
    phase_1_tables: PHASE_1_PROPAGATION_TABLES,
    inputs: {
      next_product_19_contract: ".cursor/audit-reports/next-product-19/20260515T054100Z/dry-run-output-contract.md",
      next_18m_dir: overlay.inputDir,
      organization_id: options.organizationId ?? null,
      store_id: options.storeId ?? null,
      max_rows_per_table: options.maxRowsPerTable ?? null,
    },
    cli_args: options.cliArgs ?? {},
    env_hash: options.envHashInput ? sha256Hex(options.envHashInput) : null,
    node_version: process.version,
    supabase_js_version: options.supabaseJsVersion ?? null,
    generator_git_sha: options.generatorGitSha ?? null,
    files: [
      "manifest.json",
      "run-summary.json",
      "00-propagation-rows.csv",
      "01-propagation-rows.ndjson",
      "02-would-write.csv",
      "03-would-review.csv",
      "04-would-create-product.csv",
      "05-blocked-by-dispute.csv",
      "10-validation-checks.json",
      "logs/decision-trace.ndjson",
      "validation-results.md",
      "next-step-recommendation.md",
    ],
  });

  writeJson(path.join(runDir, "run-summary.json"), {
    run_id: runId,
    started_at: startedAt,
    finished_at: finishedAt,
    rows_analyzed: rows.length,
    rows_analyzed_by_table: tableProcessed,
    table_summary: tableSummary,
    would_write_count: rows.filter((row) => row.would_write).length,
    would_review_count: rows.filter((row) => row.would_review).length,
    would_create_product_count: rows.filter((row) => row.would_create_product).length,
    blocked_by_dispute_count: rows.filter((row) => row.blocked_by_dispute).length,
    next_18m_overlay: {
      input_dir: overlay.inputDir,
      records: overlay.records,
      c1_c4_records: overlay.c1c4Records,
      c1_c4_product_ids: overlay.productIds.size,
    },
    index_load_stats: indexLoadStats,
    validation_checks: checks,
    current_blockers: blockers,
  });

  writeCsv(path.join(runDir, "00-propagation-rows.csv"), PROPAGATION_ROW_HEADERS, allRowsCsv);
  const rowsNdjson = new NDJsonWriter(path.join(runDir, "01-propagation-rows.ndjson"));
  for (const row of rows) rowsNdjson.write(row);
  await rowsNdjson.close();
  writeCsv(path.join(runDir, "02-would-write.csv"), PROPAGATION_ROW_HEADERS, allRowsCsv.filter((row) => row.would_write));
  writeCsv(path.join(runDir, "03-would-review.csv"), PROPAGATION_ROW_HEADERS, allRowsCsv.filter((row) => row.would_review));
  writeCsv(
    path.join(runDir, "04-would-create-product.csv"),
    PROPAGATION_ROW_HEADERS,
    allRowsCsv.filter((row) => row.would_create_product),
  );
  writeCsv(
    path.join(runDir, "05-blocked-by-dispute.csv"),
    PROPAGATION_ROW_HEADERS,
    allRowsCsv.filter((row) => row.blocked_by_dispute),
  );
  writeJson(path.join(runDir, "10-validation-checks.json"), checks);
  writeValidationMarkdown(runDir, checks, tableSummary);
  writeNextStepRecommendation(runDir, checks);

  return {
    runId,
    runDir,
    rowsAnalyzedByTable: tableProcessed,
    wouldWriteCount: rows.filter((row) => row.would_write).length,
    wouldReviewCount: rows.filter((row) => row.would_review).length,
    blockedByDisputeCount: rows.filter((row) => row.blocked_by_dispute).length,
    currentBlockers: blockers,
    validationChecks: checks,
  };
}
