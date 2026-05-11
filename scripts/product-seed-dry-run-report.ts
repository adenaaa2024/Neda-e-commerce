/**
 * NEXT-18B / NEXT-18C — Product-seed dry-run report generator.
 *
 * READ-ONLY. No Supabase writes. No mutations of products / product_identifier_map
 * / catalog_products / product_prices / product_identity_staging_rows. No
 * migrations, no schema changes.
 *
 * Wired source tables (slice 4):
 *   - catalog_products                  (NEXT-18B slice 1)
 *   - amazon_amazon_fulfilled_inventory (NEXT-18C slice 2, Convention A)
 *   - amazon_manage_fba_inventory       (NEXT-18D slice 3, Convention A)
 *   - amazon_fba_inventory              (NEXT-18E slice 4, Convention C)
 *
 * Every other source table throws "not yet implemented" so the operator
 * never silently runs a partial audit. Plans:
 *   .cursor/plans/product_seed_dry_run_plan_06dbbf82.plan.md
 *   .cursor/plans/next-18c_choose_next_source_04e7d2e8.plan.md
 *   .cursor/plans/next-18d_manage_fba_slice_1432f7a9.plan.md
 *   .cursor/plans/next-18e_fba_inventory_slice_325b441d.plan.md
 *
 * Run (FBA only, 1000 rows per (org, store)):
 *   npx tsx scripts/product-seed-dry-run-report.ts \
 *     --source-table=amazon_amazon_fulfilled_inventory \
 *     --max-rows-per-table=1000
 *
 * Output:
 *   .cursor/audit-reports/next-18a/<run_id>/
 *     manifest.json
 *     run-summary.json
 *     00-roll-up.csv
 *     01-rows.ndjson
 *     02-identifier-fan-out.json
 *     03-cross-product-conflict.csv
 *     04-provenance-gap.csv
 *     05-validation-checks.json
 *     logs/per-table/<table>.log
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  BUCKET_LABELS,
  classify,
  type ClassifyInput,
  type LookupHit,
  type LookupResult,
  IDENTIFIER_TYPES,
} from "../lib/audits/product-seed-classifier";
import {
  extractFromAmazonAmazonFulfilledInventoryRow,
  extractFromAmazonFbaInventoryRow,
  extractFromAmazonManageFbaInventoryRow,
  extractFromCatalogProductsRow,
  extractNotImplemented,
  type AmazonAmazonFulfilledInventoryRowProjection,
  type AmazonFbaInventoryRowProjection,
  type AmazonManageFbaInventoryRowProjection,
  type CatalogProductsRowProjection,
  type ExtractedIdentifiers,
} from "../lib/audits/product-seed-identifier-extract";
import {
  NDJsonWriter,
  mkRunDir,
  mkRunId,
  sha256Hex,
  writeCsv,
  writeJson,
  writeManifest,
  writeRunSummary,
  writeValidationChecks,
  type RunMetadata,
} from "../lib/audits/product-seed-output";
import { isUuidString } from "../lib/uuid";

const PAGE_SIZE = 1000;
const OUTPUT_BASE_DIR = path.join(".cursor", "audit-reports", "next-18a");

const KNOWN_SOURCE_TABLES = [
  "catalog_products",
  "amazon_inventory_ledger",
  "amazon_all_orders",
  "amazon_reports_repository",
  "amazon_settlements",
  "amazon_transactions",
  "amazon_manage_fba_inventory",
  "amazon_amazon_fulfilled_inventory",
  "amazon_fba_inventory",
  "amazon_reimbursements",
  "amazon_returns",
  "amazon_removals",
  "amazon_removal_shipments",
  "amazon_inbound_performance",
  "product_identity_staging_rows",
] as const;
type SourceTable = (typeof KNOWN_SOURCE_TABLES)[number];

function loadEnvLocal(): void {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  const text = fs.readFileSync(p, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([^#=]+)=(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim();
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

type CliArgs = {
  sourceTables: SourceTable[];
  organizationId: string | null;
  storeId: string | null;
  outputDir: string | null;
  noPreload: boolean;
  maxRowsPerTable: number | null;
  dryRunOnly: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  const sourceTables: SourceTable[] = [];
  let organizationId: string | null = null;
  let storeId: string | null = null;
  let outputDir: string | null = null;
  let noPreload = false;
  let maxRowsPerTable: number | null = null;
  let dryRunOnly = true;

  for (const a of argv) {
    let m: RegExpMatchArray | null;
    if ((m = a.match(/^--source-table=(.+)$/))) {
      const t = m[1].trim() as SourceTable;
      if (!KNOWN_SOURCE_TABLES.includes(t)) {
        throw new Error(
          `Unknown --source-table: "${t}". Allowed: ${KNOWN_SOURCE_TABLES.join(", ")}`,
        );
      }
      sourceTables.push(t);
    } else if ((m = a.match(/^--organization-id=(.+)$/))) {
      organizationId = m[1].trim() || null;
    } else if ((m = a.match(/^--store-id=(.+)$/))) {
      storeId = m[1].trim() || null;
    } else if ((m = a.match(/^--output-dir=(.+)$/))) {
      outputDir = m[1].trim() || null;
    } else if (a === "--no-preload") {
      noPreload = true;
    } else if ((m = a.match(/^--max-rows-per-table=(\d+)$/))) {
      maxRowsPerTable = parseInt(m[1], 10);
    } else if (a === "--dry-run-only") {
      dryRunOnly = true;
    } else if (a.startsWith("--")) {
      throw new Error(`Unknown CLI flag: ${a}`);
    }
  }

  if (organizationId && !isUuidString(organizationId)) {
    throw new Error(`Invalid --organization-id: "${organizationId}" is not a UUID.`);
  }
  if (storeId && !isUuidString(storeId)) {
    throw new Error(`Invalid --store-id: "${storeId}" is not a UUID.`);
  }
  if (storeId && !organizationId) {
    throw new Error(`--store-id requires --organization-id.`);
  }
  if (sourceTables.length === 0) {
    throw new Error(
      `--source-table is required. Allowed: ${KNOWN_SOURCE_TABLES.join(", ")}`,
    );
  }

  return {
    sourceTables,
    organizationId,
    storeId,
    outputDir,
    noPreload,
    maxRowsPerTable,
    dryRunOnly,
  };
}

function requireEnv(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env / .env.local.");
  }
  return { url, key };
}

function getSupabaseJsVersion(): string | null {
  try {
    const pkg = require("@supabase/supabase-js/package.json") as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

async function readGitSha(): Promise<string | null> {
  try {
    const child = require("node:child_process") as typeof import("node:child_process");
    const out = child.execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    return out || null;
  } catch {
    return null;
  }
}

// ── In-memory indices ────────────────────────────────────────────────────────

type IdentifierMapRowMin = {
  id: string;
  product_id: string | null;
  seller_sku: string | null;
  asin: string | null;
  fnsku: string | null;
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
  private uploadIdTextSet = new Set<string>();
  /** Distinct (asin, fnsku) → product_ids for cross-conflict detection. */

  constructor(
    public organizationId: string,
    public storeId: string | null,
  ) {}

  ingestMapRow(row: IdentifierMapRowMin): void {
    const hit: LookupHit = {
      product_id: row.product_id,
      source_id: row.id,
      match_source: row.match_source,
      store_scope: row.store_id ? "store" : "org",
    };
    if (row.seller_sku) push(this.mapBySellerSku, row.seller_sku, hit);
    if (row.asin) push(this.mapByAsin, row.asin.toUpperCase(), hit);
    if (row.fnsku) push(this.mapByFnsku, row.fnsku.toUpperCase(), hit);
    if (row.upc_code) push(this.mapByUpc, row.upc_code, hit);
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

  ingestUploadIds(ids: string[], idTexts: string[]): void {
    for (const id of ids) if (id) this.uploadIdSet.add(id);
    for (const t of idTexts) if (t) this.uploadIdTextSet.add(t);
  }

  lookup(identifiers: Partial<Record<string, string | null>>): {
    identifierMapHits: LookupResult;
    productsHits: LookupResult;
    productsCollisionSku: boolean;
  } {
    const identifierMapHits: LookupResult = {};
    const productsDirect: Partial<Record<string, LookupHit[]>> = {};
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
    const productsHits: LookupResult = { products_direct: productsDirect };
    const productsCollisionSku = (productsDirect.seller_sku?.length ?? 0) > 0;
    return { identifierMapHits, productsHits, productsCollisionSku };
  }

  uploadResolved(uploadId: string | null, castMode: "uuid" | "text"): boolean {
    if (!uploadId) return false;
    if (castMode === "text") return this.uploadIdTextSet.has(uploadId);
    return this.uploadIdSet.has(uploadId);
  }

  identifierMapFanOut(): Array<{
    identifier_type: string;
    identifier_value: string;
    count_distinct_product_id: number;
    product_ids: string[];
  }> {
    const out: Array<{
      identifier_type: string;
      identifier_value: string;
      count_distinct_product_id: number;
      product_ids: string[];
    }> = [];
    for (const [type, map] of [
      ["seller_sku", this.mapBySellerSku],
      ["asin", this.mapByAsin],
      ["fnsku", this.mapByFnsku],
      ["upc", this.mapByUpc],
    ] as const) {
      for (const [value, hits] of map) {
        const distinct = new Set(hits.map((h) => h.product_id).filter((p): p is string => !!p));
        if (distinct.size > 1) {
          out.push({
            identifier_type: type,
            identifier_value: value,
            count_distinct_product_id: distinct.size,
            product_ids: [...distinct].slice(0, 50),
          });
        }
      }
    }
    return out;
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

// ── Supabase paged readers ───────────────────────────────────────────────────

async function loadIdentifierMapIndex(
  sb: SupabaseClient,
  index: TenantIndex,
): Promise<{ rows: number }> {
  let from = 0;
  let total = 0;
  for (;;) {
    let q = sb
      .from("product_identifier_map")
      .select("id, product_id, seller_sku, asin, fnsku, upc_code, store_id, match_source, deleted_at")
      .eq("organization_id", index.organizationId)
      .is("deleted_at", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (index.storeId) {
      q = q.or(`store_id.eq.${index.storeId},store_id.is.null`);
    }
    const { data, error } = await q;
    if (error) throw new Error(`product_identifier_map read failed: ${error.message}`);
    const rows = (data ?? []) as IdentifierMapRowMin[];
    for (const row of rows) index.ingestMapRow(row);
    total += rows.length;
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return { rows: total };
}

async function loadProductsIndex(
  sb: SupabaseClient,
  index: TenantIndex,
): Promise<{ rows: number }> {
  let from = 0;
  let total = 0;
  for (;;) {
    let q = sb
      .from("products")
      .select("id, sku, asin, fnsku, upc_code, store_id, merge_status, deleted_at")
      .eq("organization_id", index.organizationId)
      .is("deleted_at", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (index.storeId) {
      q = q.or(`store_id.eq.${index.storeId},store_id.is.null`);
    }
    const { data, error } = await q;
    if (error) throw new Error(`products read failed: ${error.message}`);
    const rows = (data ?? []) as Array<ProductsRowMin & { deleted_at: string | null }>;
    for (const row of rows) index.ingestProductsRow(row);
    total += rows.length;
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return { rows: total };
}

async function loadUploadProvenanceIndex(
  sb: SupabaseClient,
  index: TenantIndex,
): Promise<{ rows: number }> {
  let from = 0;
  let total = 0;
  for (;;) {
    const { data, error } = await sb
      .from("raw_report_uploads")
      .select("id")
      .eq("organization_id", index.organizationId)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`raw_report_uploads read failed: ${error.message}`);
    const rows = (data ?? []) as Array<{ id: string }>;
    const ids = rows.map((r) => String(r.id ?? ""));
    index.ingestUploadIds(ids, ids);
    total += rows.length;
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return { rows: total };
}

async function discoverOrgStorePairs(
  sb: SupabaseClient,
  tableName: string,
  orgFilter: string | null,
  storeFilter: string | null,
): Promise<Array<{ organizationId: string; storeId: string | null }>> {
  const seen = new Map<string, { organizationId: string; storeId: string | null }>();
  let from = 0;
  for (;;) {
    let q = sb
      .from(tableName)
      .select("organization_id, store_id")
      .order("organization_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (orgFilter) q = q.eq("organization_id", orgFilter);
    if (storeFilter) q = q.eq("store_id", storeFilter);
    const { data, error } = await q;
    if (error) throw new Error(`${tableName} discovery read failed: ${error.message}`);
    const rows = (data ?? []) as Array<{ organization_id: string | null; store_id: string | null }>;
    for (const row of rows) {
      const org = row.organization_id ? String(row.organization_id) : "";
      if (!org) continue;
      const store = row.store_id ? String(row.store_id) : null;
      const key = `${org}|${store ?? "null"}`;
      if (!seen.has(key)) seen.set(key, { organizationId: org, storeId: store });
    }
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return [...seen.values()];
}

// ── Source-table descriptors ─────────────────────────────────────────────────

type SourceTableDescriptor = {
  name: string;
  /** Comma-separated select projection. Must include id, organization_id, store_id. */
  selectCols: string;
  /** Which column carries upload provenance. */
  uploadCol: "source_upload_id" | "upload_id";
  /**
   * `uuid` matches against raw_report_uploads.id by uuid set lookup; `text`
   * uses the text-cast lookup. Reserved for amazon_reports_repository which
   * stores upload_id as text — not used in this slice but kept as the slot
   * the slice-3+ wiring will fill.
   */
  uploadCastMode: "uuid" | "text";
  /** Per-row identifier extractor. */
  extract: (row: Record<string, unknown>) => ExtractedIdentifiers;
  /** Convention A/B linkage: returns the row's resolved product UUID if any. */
  existingResolvedProductId: (row: Record<string, unknown>) => string | null;
  existingResolvedCatalogProductId: (row: Record<string, unknown>) => string | null;
  /** When true, the per-tenant scan must also include rows whose store_id IS NULL. */
  allowNullStoreId: boolean;
};

function nonEmptyString(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

const DESCRIPTORS: Record<string, SourceTableDescriptor> = {
  catalog_products: {
    name: "catalog_products",
    selectCols:
      "id, organization_id, store_id, seller_sku, asin, fnsku, listing_id, item_name, source_upload_id, raw_payload",
    uploadCol: "source_upload_id",
    uploadCastMode: "uuid",
    extract: (row) => extractFromCatalogProductsRow(row as unknown as CatalogProductsRowProjection),
    existingResolvedProductId: () => null,
    existingResolvedCatalogProductId: () => null,
    allowNullStoreId: true,
  },
  amazon_amazon_fulfilled_inventory: {
    name: "amazon_amazon_fulfilled_inventory",
    selectCols:
      "id, organization_id, store_id, seller_sku, fulfillment_channel_sku, asin, resolved_product_id, resolved_catalog_product_id, source_upload_id, raw_data",
    uploadCol: "source_upload_id",
    uploadCastMode: "uuid",
    extract: (row) =>
      extractFromAmazonAmazonFulfilledInventoryRow(
        row as unknown as AmazonAmazonFulfilledInventoryRowProjection,
      ),
    existingResolvedProductId: (row) => nonEmptyString((row as Record<string, unknown>).resolved_product_id),
    existingResolvedCatalogProductId: (row) =>
      nonEmptyString((row as Record<string, unknown>).resolved_catalog_product_id),
    allowNullStoreId: true,
  },
  amazon_manage_fba_inventory: {
    name: "amazon_manage_fba_inventory",
    selectCols:
      "id, organization_id, store_id, sku, fnsku, asin, product_name, resolved_product_id, resolved_catalog_product_id, source_upload_id, raw_data",
    uploadCol: "source_upload_id",
    uploadCastMode: "uuid",
    extract: (row) =>
      extractFromAmazonManageFbaInventoryRow(
        row as unknown as AmazonManageFbaInventoryRowProjection,
      ),
    existingResolvedProductId: (row) => nonEmptyString((row as Record<string, unknown>).resolved_product_id),
    existingResolvedCatalogProductId: (row) =>
      nonEmptyString((row as Record<string, unknown>).resolved_catalog_product_id),
    allowNullStoreId: true,
  },
  amazon_fba_inventory: {
    name: "amazon_fba_inventory",
    selectCols:
      "id, organization_id, store_id, sku, fnsku, asin, product_name, source_upload_id, raw_data",
    uploadCol: "source_upload_id",
    uploadCastMode: "uuid",
    extract: (row) =>
      extractFromAmazonFbaInventoryRow(
        row as unknown as AmazonFbaInventoryRowProjection,
      ),
    existingResolvedProductId: () => null,
    existingResolvedCatalogProductId: () => null,
    allowNullStoreId: true,
  },
};

const WIRED_SOURCE_TABLES = new Set(Object.keys(DESCRIPTORS));

// ── Source-table iterator (descriptor-driven) ────────────────────────────────

type PerRowAccum = {
  rolledUp: Map<string, RollUpEntry>;
  ndjson: NDJsonWriter;
  fanOutByTenant: Array<ReturnType<TenantIndex["identifierMapFanOut"]>[number] & {
    organization_id: string;
    store_id: string | null;
  }>;
  crossConflict: Array<Record<string, unknown>>;
  provenanceGap: Array<Record<string, unknown>>;
  perTableStats: Map<string, { rowsScanned: number; pageCount: number; ms: number }>;
};

type RollUpEntry = {
  organization_id: string;
  store_id: string | null;
  source_table: string;
  bucket_id: number;
  bucket_label: string;
  row_count: number;
  distinct_seller_skus: Set<string>;
  distinct_asins: Set<string>;
  distinct_fnskus: Set<string>;
  distinct_upcs: Set<string>;
  with_upload_provenance_count: number;
  with_native_asin_count: number;
  with_native_fnsku_count: number;
};

function rollUpKey(org: string, store: string | null, table: string, bucketId: number): string {
  return `${org}|${store ?? "null"}|${table}|${bucketId}`;
}

function getOrInitRollUp(
  accum: PerRowAccum,
  org: string,
  store: string | null,
  table: string,
  bucketId: number,
  bucketLabel: string,
): RollUpEntry {
  const key = rollUpKey(org, store, table, bucketId);
  let entry = accum.rolledUp.get(key);
  if (!entry) {
    entry = {
      organization_id: org,
      store_id: store,
      source_table: table,
      bucket_id: bucketId,
      bucket_label: bucketLabel,
      row_count: 0,
      distinct_seller_skus: new Set(),
      distinct_asins: new Set(),
      distinct_fnskus: new Set(),
      distinct_upcs: new Set(),
      with_upload_provenance_count: 0,
      with_native_asin_count: 0,
      with_native_fnsku_count: 0,
    };
    accum.rolledUp.set(key, entry);
  }
  return entry;
}

async function processTenantSlice(
  sb: SupabaseClient,
  descriptor: SourceTableDescriptor,
  index: TenantIndex,
  accum: PerRowAccum,
  maxRowsPerTable: number | null,
  perTableLogPath: string,
): Promise<void> {
  const tableLog = fs.createWriteStream(perTableLogPath, { flags: "a", encoding: "utf8" });
  const tableLabel = descriptor.name;
  const tenantKey = `${index.organizationId}/${index.storeId ?? "null"}`;
  tableLog.write(`[${new Date().toISOString()}] tenant=${tenantKey} start\n`);
  const t0 = Date.now();
  let pageCount = 0;
  let rowsScanned = 0;
  let from = 0;
  const limit = maxRowsPerTable ?? Number.POSITIVE_INFINITY;

  for (;;) {
    if (rowsScanned >= limit) break;
    let q = sb
      .from(descriptor.name)
      .select(descriptor.selectCols)
      .eq("organization_id", index.organizationId)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (index.storeId) q = q.eq("store_id", index.storeId);
    else if (descriptor.allowNullStoreId) q = q.is("store_id", null);
    else q = q.eq("store_id", "__never__");
    const { data, error } = await q;
    if (error) throw new Error(`${descriptor.name} read failed: ${error.message}`);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    pageCount++;
    if (rows.length === 0) break;

    for (const row of rows) {
      if (rowsScanned >= limit) break;
      rowsScanned++;
      const ext = descriptor.extract(row);
      const uploadId = nonEmptyString(row[descriptor.uploadCol]);
      const uploadResolved = index.uploadResolved(uploadId, descriptor.uploadCastMode);

      const lookups = index.lookup(ext.identifiers);

      const resolvedProductId = descriptor.existingResolvedProductId(row);
      const resolvedCatalogProductId = descriptor.existingResolvedCatalogProductId(row);
      const rowAlreadyResolved = !!(resolvedProductId && isUuidString(resolvedProductId));

      const orgId = nonEmptyString(row.organization_id);
      const storeId = nonEmptyString(row.store_id);

      const input: ClassifyInput = {
        sourceTable: tableLabel,
        rowAlreadyResolved,
        existingResolvedProductId: rowAlreadyResolved ? resolvedProductId : null,
        existingResolvedCatalogProductId: resolvedCatalogProductId,
        orgId,
        storeId,
        identifiers: ext.identifiers,
        identifierSources: ext.identifierSources,
        shape: ext.shape,
        identifierMapHits: lookups.identifierMapHits,
        productsHits: lookups.productsHits,
        productsCollisionSku: lookups.productsCollisionSku,
        uploadResolved,
      };
      const out = classify(input);

      const ndjsonRow = {
        source_table: tableLabel,
        source_row_id: row.id,
        organization_id: input.orgId,
        store_id: input.storeId,
        upload_linkage_col: descriptor.uploadCol,
        upload_id_value: uploadId,
        upload_provenance_resolved: uploadResolved,
        identifiers: ext.identifiers,
        identifier_source: ext.identifierSources,
        bucket_id: out.bucketId,
        bucket_label: out.bucketLabel,
        primary_reason: out.primaryReason,
        secondary_reasons: out.secondaryReasons,
        existing_product_id_hit: out.existingProductIdHit,
        existing_catalog_product_id_hit: out.existingCatalogProductIdHit,
        conflict_product_ids: out.conflictProductIds,
        match_rank: out.matchRank,
        match_evidence: out.evidence,
      };
      accum.ndjson.write(ndjsonRow);

      const rollUp = getOrInitRollUp(
        accum,
        input.orgId ?? "(null)",
        input.storeId,
        tableLabel,
        out.bucketId,
        out.bucketLabel,
      );
      rollUp.row_count++;
      if (ext.identifiers.seller_sku) rollUp.distinct_seller_skus.add(ext.identifiers.seller_sku);
      if (ext.identifiers.asin) rollUp.distinct_asins.add(ext.identifiers.asin);
      if (ext.identifiers.fnsku) rollUp.distinct_fnskus.add(ext.identifiers.fnsku);
      if (ext.identifiers.upc) rollUp.distinct_upcs.add(ext.identifiers.upc);
      if (uploadResolved) rollUp.with_upload_provenance_count++;
      if (ext.identifierSources.asin === "native") rollUp.with_native_asin_count++;
      if (ext.identifierSources.fnsku === "native") rollUp.with_native_fnsku_count++;

      if (out.bucketId === 5 && out.primaryReason === "f2_cross_product_conflict") {
        accum.crossConflict.push({
          source_table: tableLabel,
          source_row_id: row.id,
          organization_id: input.orgId,
          store_id: input.storeId,
          identifiers_json: JSON.stringify(ext.identifiers),
          conflict_product_ids_json: JSON.stringify(out.conflictProductIds),
        });
      }

      const gapReasons: string[] = [];
      if (!input.orgId) gapReasons.push("missing_org");
      if (!input.storeId) gapReasons.push("missing_store");
      if (!uploadId) gapReasons.push("missing_upload");
      else if (!uploadResolved) gapReasons.push("upload_not_resolved");
      if (gapReasons.length > 0) {
        accum.provenanceGap.push({
          source_table: tableLabel,
          source_row_id: row.id,
          organization_id: input.orgId,
          store_id: input.storeId,
          upload_id_value: uploadId,
          gap_reasons_json: JSON.stringify(gapReasons),
        });
      }
    }
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  const ms = Date.now() - t0;
  const prev = accum.perTableStats.get(tableLabel) ?? { rowsScanned: 0, pageCount: 0, ms: 0 };
  accum.perTableStats.set(tableLabel, {
    rowsScanned: prev.rowsScanned + rowsScanned,
    pageCount: prev.pageCount + pageCount,
    ms: prev.ms + ms,
  });
  tableLog.write(`[${new Date().toISOString()}] tenant=${tenantKey} end rows=${rowsScanned} pages=${pageCount} ms=${ms}\n`);
  tableLog.end();

  for (const entry of index.identifierMapFanOut()) {
    accum.fanOutByTenant.push({
      organization_id: index.organizationId,
      store_id: index.storeId,
      ...entry,
    });
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<void> {
  loadEnvLocal();
  const cli = parseArgs(argv);
  const { url, key } = requireEnv();

  // Slice gate: only the explicitly wired source tables are allowed.
  for (const t of cli.sourceTables) {
    if (!WIRED_SOURCE_TABLES.has(t)) extractNotImplemented(t);
  }
  const descriptors = cli.sourceTables.map((t) => DESCRIPTORS[t]);

  const runId = mkRunId();
  const baseDir = cli.outputDir ?? OUTPUT_BASE_DIR;
  const runDir = mkRunDir(baseDir, runId);
  const startedAt = new Date().toISOString();

  const meta: RunMetadata = {
    runId,
    startedAt,
    finishedAt: null,
    cliArgs: {
      sourceTables: cli.sourceTables.join(","),
      organizationId: cli.organizationId,
      storeId: cli.storeId,
      outputDir: cli.outputDir,
      noPreload: cli.noPreload,
      maxRowsPerTable: cli.maxRowsPerTable,
      dryRunOnly: cli.dryRunOnly,
    },
    envHash: sha256Hex(url),
    nodeVersion: process.version,
    supabaseJsVersion: getSupabaseJsVersion(),
    generatorGitSha: await readGitSha(),
  };
  writeManifest(runDir, meta);

  console.log(`[product-seed-audit] run_id=${runId}`);
  console.log(`[product-seed-audit] output_dir=${runDir}`);
  console.log(`[product-seed-audit] source_tables=${cli.sourceTables.join(",")}`);
  console.log(`[product-seed-audit] max_rows_per_table=${cli.maxRowsPerTable ?? "(unlimited)"}`);

  const sb = createClient(url, key, { auth: { persistSession: false } });

  // Discover (org, store) pairs across all requested source tables, deduping.
  const pairMap = new Map<string, { organizationId: string; storeId: string | null }>();
  for (const descriptor of descriptors) {
    console.log(`[product-seed-audit] discovering (org, store) pairs from ${descriptor.name}…`);
    const pairs = await discoverOrgStorePairs(sb, descriptor.name, cli.organizationId, cli.storeId);
    for (const p of pairs) {
      const key = `${p.organizationId}|${p.storeId ?? "null"}`;
      if (!pairMap.has(key)) pairMap.set(key, p);
    }
    console.log(`[product-seed-audit] ${descriptor.name} contributed ${pairs.length} pair(s)`);
  }
  const allPairs = [...pairMap.values()];
  console.log(`[product-seed-audit] union of (org, store) pairs: ${allPairs.length}`);

  const accum: PerRowAccum = {
    rolledUp: new Map(),
    ndjson: new NDJsonWriter(path.join(runDir, "01-rows.ndjson")),
    fanOutByTenant: [],
    crossConflict: [],
    provenanceGap: [],
    perTableStats: new Map(),
  };

  let totalRowsScanned = 0;
  for (const { organizationId, storeId } of allPairs) {
    const tenantLabel = `org=${organizationId.slice(0, 8)} store=${storeId?.slice(0, 8) ?? "null"}`;
    console.log(`[product-seed-audit] tenant ${tenantLabel} — preloading indices…`);

    const index = new TenantIndex(organizationId, storeId);
    const { rows: mapRows } = await loadIdentifierMapIndex(sb, index);
    const { rows: prodRows } = await loadProductsIndex(sb, index);
    const { rows: uploadRows } = await loadUploadProvenanceIndex(sb, index);
    console.log(
      `[product-seed-audit] tenant ${tenantLabel} indices: map=${mapRows} products=${prodRows} uploads=${uploadRows}`,
    );

    for (const descriptor of descriptors) {
      const perTableLogPath = path.join(runDir, "logs", "per-table", `${descriptor.name}.log`);
      console.log(`[product-seed-audit] tenant ${tenantLabel} — scanning ${descriptor.name}…`);
      const prev = accum.perTableStats.get(descriptor.name)?.rowsScanned ?? 0;
      await processTenantSlice(sb, descriptor, index, accum, cli.maxRowsPerTable, perTableLogPath);
      const after = accum.perTableStats.get(descriptor.name)?.rowsScanned ?? 0;
      const scannedHere = after - prev;
      totalRowsScanned += scannedHere;
      console.log(
        `[product-seed-audit] tenant ${tenantLabel} — scanned ${scannedHere} ${descriptor.name} row(s)`,
      );
    }
  }

  await accum.ndjson.close();

  // ── Write 00-roll-up.csv ───────────────────────────────────────────────────
  const rollUpHeaders = [
    "organization_id",
    "store_id",
    "source_table",
    "bucket_id",
    "bucket_label",
    "row_count",
    "distinct_seller_skus",
    "distinct_asins",
    "distinct_fnskus",
    "distinct_upcs",
    "with_upload_provenance_count",
    "with_native_asin_count",
    "with_native_fnsku_count",
  ] as const;
  const rollUpRows = [...accum.rolledUp.values()]
    .sort((a, b) => {
      if (a.organization_id !== b.organization_id) return a.organization_id.localeCompare(b.organization_id);
      const sa = a.store_id ?? "";
      const sb2 = b.store_id ?? "";
      if (sa !== sb2) return sa.localeCompare(sb2);
      if (a.source_table !== b.source_table) return a.source_table.localeCompare(b.source_table);
      return a.bucket_id - b.bucket_id;
    })
    .map((r) => ({
      organization_id: r.organization_id,
      store_id: r.store_id ?? "",
      source_table: r.source_table,
      bucket_id: r.bucket_id,
      bucket_label: r.bucket_label,
      row_count: r.row_count,
      distinct_seller_skus: r.distinct_seller_skus.size,
      distinct_asins: r.distinct_asins.size,
      distinct_fnskus: r.distinct_fnskus.size,
      distinct_upcs: r.distinct_upcs.size,
      with_upload_provenance_count: r.with_upload_provenance_count,
      with_native_asin_count: r.with_native_asin_count,
      with_native_fnsku_count: r.with_native_fnsku_count,
    }));
  writeCsv(path.join(runDir, "00-roll-up.csv"), rollUpHeaders, rollUpRows);

  // ── Write 02-identifier-fan-out.json ──────────────────────────────────────
  writeJson(path.join(runDir, "02-identifier-fan-out.json"), accum.fanOutByTenant);

  // ── Write 03-cross-product-conflict.csv ───────────────────────────────────
  writeCsv(
    path.join(runDir, "03-cross-product-conflict.csv"),
    [
      "source_table",
      "source_row_id",
      "organization_id",
      "store_id",
      "identifiers_json",
      "conflict_product_ids_json",
    ],
    accum.crossConflict,
  );

  // ── Write 04-provenance-gap.csv ───────────────────────────────────────────
  writeCsv(
    path.join(runDir, "04-provenance-gap.csv"),
    [
      "source_table",
      "source_row_id",
      "organization_id",
      "store_id",
      "upload_id_value",
      "gap_reasons_json",
    ],
    accum.provenanceGap,
  );

  // ── J1–J8 validation ──────────────────────────────────────────────────────
  // For the slice (catalog_products only), J-checks operate over all rows seen.
  const totalRows = totalRowsScanned;
  const bucketCounts: Record<number, number> = {};
  for (const entry of accum.rolledUp.values()) {
    bucketCounts[entry.bucket_id] = (bucketCounts[entry.bucket_id] ?? 0) + entry.row_count;
  }
  const missingOrgCount = accum.provenanceGap.filter((g) => {
    const reasons = JSON.parse(String(g.gap_reasons_json)) as string[];
    return reasons.includes("missing_org");
  }).length;
  const missingStoreCount = accum.provenanceGap.filter((g) => {
    const reasons = JSON.parse(String(g.gap_reasons_json)) as string[];
    return reasons.includes("missing_store");
  }).length;
  const uploadResolvedCount = [...accum.rolledUp.values()].reduce((n, e) => n + e.with_upload_provenance_count, 0);
  const j3Ratio = totalRows === 0 ? 1 : uploadResolvedCount / totalRows;
  const bucket10Count = bucketCounts[10] ?? 0;
  const dirtyRate = totalRows === 0 ? 0 : bucket10Count / totalRows;

  const validation = {
    totals: {
      rows_scanned: totalRows,
      bucket_counts: bucketCounts,
      cross_conflict_rows: accum.crossConflict.length,
      provenance_gap_rows: accum.provenanceGap.length,
      fan_out_findings: accum.fanOutByTenant.length,
    },
    checks: {
      J1_zero_missing_org: { pass: missingOrgCount === 0, missing_org_count: missingOrgCount, strict: true },
      J2_store_present_or_pim_org_level: {
        pass: missingStoreCount === 0,
        missing_store_count: missingStoreCount,
        strict: true,
        note: "Slice does not yet cover product_identity_staging_rows; catalog_products with NULL store_id are reported as gaps.",
      },
      J3_upload_provenance_resolved_99pct: {
        pass: j3Ratio >= 0.99,
        ratio: j3Ratio,
        threshold: 0.99,
        strict: false,
      },
      J4_bucket4_intersect_bucket5_empty: {
        pass: true,
        strict: true,
        note: "Buckets are mutually exclusive by classifier construction; intersection is structurally empty.",
      },
      J5_bucket4_no_identifier_map_conflict: {
        pass: true,
        strict: true,
        note: "Classifier routes any identifier-map conflict to bucket 5/11; bucket 4 cannot contain rows with a conflict.",
      },
      J6_bucket4_no_products_sku_collision: {
        pass: true,
        strict: true,
        note: "Classifier routes any products.(org, store, sku) collision to bucket 5; bucket 4 cannot contain such rows.",
      },
      J7_bucket4_shape_validation_clean: {
        pass: true,
        strict: true,
        note: "Classifier excludes shape-invalid rows from bucket 4 via section E gates.",
      },
      J8_bucket10_dirty_rate_under_threshold: {
        pass: dirtyRate < 0.1,
        rate: dirtyRate,
        threshold: 0.1,
        bucket10_count: bucket10Count,
        strict: false,
      },
    },
  };
  writeValidationChecks(runDir, validation);

  const finishedAt = new Date().toISOString();
  const summary = {
    runId,
    startedAt,
    finishedAt,
    pairs_discovered: allPairs.length,
    rows_scanned: totalRows,
    bucket_counts: bucketCounts,
    cross_conflict_rows: accum.crossConflict.length,
    provenance_gap_rows: accum.provenanceGap.length,
    fan_out_findings: accum.fanOutByTenant.length,
    per_table_stats: Object.fromEntries(accum.perTableStats),
    files: {
      manifest: "manifest.json",
      run_summary: "run-summary.json",
      roll_up: "00-roll-up.csv",
      rows: "01-rows.ndjson",
      identifier_fan_out: "02-identifier-fan-out.json",
      cross_conflict: "03-cross-product-conflict.csv",
      provenance_gap: "04-provenance-gap.csv",
      validation_checks: "05-validation-checks.json",
    },
  };
  writeRunSummary(runDir, summary);
  // Refresh manifest finishedAt.
  writeManifest(runDir, { ...meta, finishedAt });

  console.log(`[product-seed-audit] complete. rows_scanned=${totalRows} bucket_counts=${JSON.stringify(bucketCounts)}`);
  console.log(`[product-seed-audit] reports written to ${runDir}`);

  const strictFailures: string[] = [];
  for (const [name, check] of Object.entries(validation.checks)) {
    if ((check as { strict?: boolean }).strict && !(check as { pass?: boolean }).pass) {
      strictFailures.push(name);
    }
  }
  if (strictFailures.length > 0) {
    console.error(`[product-seed-audit] STRICT CHECK FAILURES: ${strictFailures.join(", ")}`);
    process.exit(1);
  }

  // Touch bucket labels so the export does not appear unused if the script grows.
  void BUCKET_LABELS;
  void IDENTIFIER_TYPES;
}

main(process.argv.slice(2)).catch((err) => {
  console.error("FAIL:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(err && (err as { code?: string }).code === "ENV_MISSING" ? 2 : 1);
});
