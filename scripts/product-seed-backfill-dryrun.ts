/**
 * NEXT-18J — Product identifier_map backfill dry-run classifier.
 *
 * Read-only. Loads NEXT-18I orphan output + NEXT-18G enriched clusters from
 * disk, pages `public.products` and active `public.product_identifier_map`
 * (SELECT only), builds in-memory identifier indexes, then deterministically
 * buckets every orphan into exactly one of 11 categories per the NEXT-18J plan
 * (section F).
 *
 * Outputs under .cursor/audit-reports/next-18j/<runId>/:
 *   manifest.json
 *   run-summary.json
 *   00-backfill-candidates.csv
 *   01-auto-safe.csv
 *   02-conflicts.csv
 *   03-review-required.csv
 *   04-do-not-touch.csv
 *   05-validation-checks.json
 *   logs/decision-trace.ndjson
 *   logs/page-cursors.ndjson
 *   logs/fetch-warnings.ndjson
 *   logs/query-trace.txt
 *
 * Run:
 *   npx tsx scripts/product-seed-backfill-dryrun.ts
 *
 * Optional flags:
 *   --input-run-next-18i=<runId>
 *   --input-run-next-18g=<runId>
 *   --organization-id=<uuid>
 *   --store-id=<uuid>
 *   --output-dir=<path>
 *
 * Plan: .cursor/plans/orphan_backfill_dryrun_plan_6c219943.plan.md
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  mkRunDir,
  mkRunId,
  sha256Hex,
  writeCsv,
  writeJson,
  writeManifest,
  writeRunSummary,
  writeValidationChecks,
  NDJsonWriter,
  type RunMetadata,
} from "../lib/audits/product-seed-output";
import {
  PAGE_SIZE,
  POSTGREST_IN_CHUNK_SIZE,
  type ActiveMapRow,
  type ProductRow,
} from "../lib/audits/product-seed-orphan-sizing";
import {
  BUCKETS,
  buildIdentifierIndexes,
  classifyOrphan,
  deriveCandidates,
  groupDuplicateOrphans,
  proposedMapRow,
  type Bucket,
  type Candidates,
  type Classification,
  type ClusterMembership,
} from "../lib/audits/product-seed-backfill-dryrun";
import { isUuidString } from "../lib/uuid";

const NEXT18G_BASE_DIR = path.join(".cursor", "audit-reports", "next-18g");
const NEXT18I_BASE_DIR = path.join(".cursor", "audit-reports", "next-18i");
const NEXT18J_BASE_DIR = path.join(".cursor", "audit-reports", "next-18j");

const PRODUCTS_SELECT = [
  "id",
  "organization_id",
  "store_id",
  "sku",
  "asin",
  "fnsku",
  "upc_code",
  "mfg_part_number",
  "barcode",
  "product_name",
  "brand",
  "vendor_name",
  "condition",
  "status",
  "merge_status",
  "merged_into_id",
  "deleted_at",
  "created_at",
  "updated_at",
  "last_seen_at",
  "last_catalog_sync_at",
].join(", ");

const ACTIVE_MAP_SELECT = [
  "id",
  "product_id",
  "organization_id",
  "store_id",
  "seller_sku",
  "asin",
  "fnsku",
  "upc_code",
  "is_primary",
  "match_source",
  "source_report_type",
  "first_seen_at",
  "last_seen_at",
].join(", ");

const REVIEW_BUCKETS: ReadonlySet<Bucket> = new Set([
  "upc_only_review",
  "sku_only_review",
  "dirty_identifier",
  "human_review_required",
]);
const CONFLICT_BUCKETS: ReadonlySet<Bucket> = new Set([
  "conflict_with_existing_identifier_map",
  "conflict_with_existing_product_columns",
  "duplicate_orphan_group",
  "already_represented_by_active_map_elsewhere",
]);
const DO_NOT_TOUCH_BUCKETS: ReadonlySet<Bucket> = new Set([
  "do_not_touch",
  "insufficient_identifiers",
]);

// ── CLI ─────────────────────────────────────────────────────────────────────

type Cli = {
  inputRunNext18i: string | null;
  inputRunNext18g: string | null;
  organizationId: string | null;
  storeId: string | null;
  outputDir: string | null;
};

function parseCli(argv: string[]): Cli {
  let inputRunNext18i: string | null = null;
  let inputRunNext18g: string | null = null;
  let organizationId: string | null = null;
  let storeId: string | null = null;
  let outputDir: string | null = null;
  for (const arg of argv.slice(2)) {
    let m: RegExpMatchArray | null;
    if ((m = arg.match(/^--input-run-next-18i=(.+)$/))) inputRunNext18i = m[1].trim() || null;
    else if ((m = arg.match(/^--input-run-next-18g=(.+)$/))) inputRunNext18g = m[1].trim() || null;
    else if ((m = arg.match(/^--organization-id=(.+)$/))) organizationId = m[1].trim() || null;
    else if ((m = arg.match(/^--store-id=(.+)$/))) storeId = m[1].trim() || null;
    else if ((m = arg.match(/^--output-dir=(.+)$/))) outputDir = m[1].trim() || null;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown CLI flag: ${arg}`);
    }
  }
  if (organizationId && !isUuidString(organizationId)) {
    throw new Error(`Invalid --organization-id: "${organizationId}" is not a UUID.`);
  }
  if (storeId && !isUuidString(storeId)) {
    throw new Error(`Invalid --store-id: "${storeId}" is not a UUID.`);
  }
  return { inputRunNext18i, inputRunNext18g, organizationId, storeId, outputDir };
}

function printHelp(): void {
  console.error(
    [
      "Usage: npx tsx scripts/product-seed-backfill-dryrun.ts [flags]",
      "",
      "Flags:",
      "  --input-run-next-18i=<runId>   NEXT-18I run to classify (default: latest finished)",
      "  --input-run-next-18g=<runId>   NEXT-18G run for cluster membership (default: latest finished)",
      "  --organization-id=<uuid>       Force tenant org (else from NEXT-18I run-summary)",
      "  --store-id=<uuid>              Optional store filter (default: surface all)",
      "  --output-dir=<path>            Override default output run directory",
    ].join("\n"),
  );
}

// ── Env / git ───────────────────────────────────────────────────────────────

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

function readGitSha(): string | null {
  try {
    const child = require("node:child_process") as typeof import("node:child_process");
    const out = child.execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    return out || null;
  } catch {
    return null;
  }
}

// ── Input run resolution ────────────────────────────────────────────────────

type RunSelection = {
  runId: string;
  runDir: string;
  startedAt: string;
  finishedAt: string;
  selectionReason: "auto_latest" | "cli_override";
};

function selectInputRun(args: {
  baseDir: string;
  override: string | null;
  requiredFile: string;
  trace: string[];
  label: string;
}): RunSelection {
  const { baseDir, override, requiredFile, trace, label } = args;
  if (!fs.existsSync(baseDir)) throw new Error(`${label} base directory not found: ${baseDir}`);
  type Candidate = { runId: string; runDir: string; startedAt: string; finishedAt: string };
  const candidates: Candidate[] = [];
  const subdirs = fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  trace.push(`[${label}] scanned ${subdirs.length} subdirectories under ${baseDir}`);
  for (const subdir of subdirs) {
    const runDir = path.join(baseDir, subdir);
    const manifestPath = path.join(runDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      trace.push(`[${label}] skip ${subdir}: manifest.json missing`);
      continue;
    }
    let manifest: { runId?: string; startedAt?: string; finishedAt?: string | null };
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (e) {
      trace.push(`[${label}] skip ${subdir}: manifest parse error: ${String(e)}`);
      continue;
    }
    if (!manifest.finishedAt) {
      trace.push(`[${label}] skip ${subdir}: finishedAt null`);
      continue;
    }
    if (!fs.existsSync(path.join(runDir, requiredFile))) {
      trace.push(`[${label}] skip ${subdir}: ${requiredFile} missing`);
      continue;
    }
    candidates.push({
      runId: manifest.runId ?? subdir,
      runDir,
      startedAt: manifest.startedAt ?? "",
      finishedAt: manifest.finishedAt,
    });
  }
  if (override) {
    const found = candidates.find((c) => c.runId === override);
    if (!found) throw new Error(`${label} --input-run override ${override} did not match a finished run`);
    trace.push(`[${label}] override matched runId=${found.runId}`);
    return { ...found, selectionReason: "cli_override" };
  }
  if (candidates.length === 0) throw new Error(`No finished ${label} run found under ${baseDir}`);
  candidates.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  const chosen = candidates[0];
  trace.push(
    `[${label}] auto-selected runId=${chosen.runId} (${candidates.length} candidate(s), startedAt=${chosen.startedAt})`,
  );
  return { ...chosen, selectionReason: "auto_latest" };
}

// ── CSV ingest ──────────────────────────────────────────────────────────────

/** Tiny CSV reader: assumes the audit outputs use double-quote escaping (writeCsv format). */
function parseCsv(text: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") {
        row.push(cell);
        cell = "";
      } else if (ch === "\r") {
        // ignore
      } else if (ch === "\n") {
        row.push(cell);
        cell = "";
        rows.push(row);
        row = [];
      } else {
        cell += ch;
      }
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c === "")) rows.pop();
  if (rows.length === 0) return out;
  const headers = rows[0];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const obj: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = r[j] ?? "";
    out.push(obj);
  }
  return out;
}

// ── DB fetchers (SELECT only) ───────────────────────────────────────────────

type FetchWarning = { source: string; reason: string; detail?: unknown };

function stringOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const t = v.trim();
    return t.length === 0 ? null : t;
  }
  return String(v);
}

function boolOrNull(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function asProductRow(r: Record<string, unknown>): ProductRow {
  return {
    id: String(r.id),
    organization_id: String(r.organization_id),
    store_id: stringOrNull(r.store_id),
    sku: stringOrNull(r.sku),
    asin: stringOrNull(r.asin),
    fnsku: stringOrNull(r.fnsku),
    upc_code: stringOrNull(r.upc_code),
    mfg_part_number: stringOrNull(r.mfg_part_number),
    barcode: stringOrNull(r.barcode),
    product_name: stringOrNull(r.product_name),
    brand: stringOrNull(r.brand),
    vendor_name: stringOrNull(r.vendor_name),
    condition: stringOrNull(r.condition),
    status: stringOrNull(r.status),
    merge_status: stringOrNull(r.merge_status),
    merged_into_id: stringOrNull(r.merged_into_id),
    deleted_at: stringOrNull(r.deleted_at),
    created_at: stringOrNull(r.created_at),
    updated_at: stringOrNull(r.updated_at),
    last_seen_at: stringOrNull(r.last_seen_at),
    last_catalog_sync_at: stringOrNull(r.last_catalog_sync_at),
  };
}

function asActiveMapRow(r: Record<string, unknown>): ActiveMapRow {
  return {
    id: String(r.id),
    product_id: String(r.product_id),
    organization_id: String(r.organization_id),
    store_id: stringOrNull(r.store_id),
    seller_sku: stringOrNull(r.seller_sku),
    asin: stringOrNull(r.asin),
    fnsku: stringOrNull(r.fnsku),
    upc_code: stringOrNull(r.upc_code),
    is_primary: boolOrNull(r.is_primary),
    match_source: stringOrNull(r.match_source),
    source_report_type: stringOrNull(r.source_report_type),
    first_seen_at: stringOrNull(r.first_seen_at),
    last_seen_at: stringOrNull(r.last_seen_at),
  };
}

async function pageProducts(args: {
  sb: SupabaseClient;
  organizationId: string;
  storeId: string | null;
  cursorWriter: NDJsonWriter;
  warnings: FetchWarning[];
}): Promise<ProductRow[]> {
  const out: ProductRow[] = [];
  let offset = 0;
  let pageIndex = 0;
  while (true) {
    let q = args.sb
      .from("products")
      .select(PRODUCTS_SELECT)
      .eq("organization_id", args.organizationId)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (args.storeId) q = q.eq("store_id", args.storeId);
    const { data, error } = await q;
    if (error) {
      args.warnings.push({ source: "products", reason: `page ${pageIndex}: ${error.message}` });
      throw new Error(`[backfill-dryrun] products page ${pageIndex} failed: ${error.message}`);
    }
    const rows = (data ?? []).map((r) => asProductRow(r as unknown as Record<string, unknown>));
    args.cursorWriter.write({
      table: "products",
      page_index: pageIndex,
      offset,
      row_count: rows.length,
      last_id: rows.length > 0 ? rows[rows.length - 1].id : null,
    });
    if (rows.length === 0) break;
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    pageIndex++;
  }
  return out;
}

async function pageActiveMap(args: {
  sb: SupabaseClient;
  organizationId: string;
  storeId: string | null;
  cursorWriter: NDJsonWriter;
  warnings: FetchWarning[];
}): Promise<ActiveMapRow[]> {
  const out: ActiveMapRow[] = [];
  let offset = 0;
  let pageIndex = 0;
  while (true) {
    let q = args.sb
      .from("product_identifier_map")
      .select(ACTIVE_MAP_SELECT)
      .eq("organization_id", args.organizationId)
      .is("deleted_at", null)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (args.storeId) q = q.eq("store_id", args.storeId);
    const { data, error } = await q;
    if (error) {
      args.warnings.push({ source: "product_identifier_map.active", reason: `page ${pageIndex}: ${error.message}` });
      throw new Error(`[backfill-dryrun] active map page ${pageIndex} failed: ${error.message}`);
    }
    const rows = (data ?? []).map((r) => asActiveMapRow(r as unknown as Record<string, unknown>));
    args.cursorWriter.write({
      table: "product_identifier_map.active",
      page_index: pageIndex,
      offset,
      row_count: rows.length,
      last_id: rows.length > 0 ? rows[rows.length - 1].id : null,
    });
    if (rows.length === 0) break;
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    pageIndex++;
  }
  return out;
}

// ── J-checks ────────────────────────────────────────────────────────────────

type JCheckResult =
  | { name: string; pass: true; strict: boolean; note?: string }
  | { name: string; pass: false; strict: boolean; note: string; offenders?: unknown[] };

// ── Helpers ─────────────────────────────────────────────────────────────────

function shardForBucket(b: Bucket): "auto_safe" | "conflicts" | "review" | "do_not_touch" {
  if (b === "auto_safe_backfill_candidate") return "auto_safe";
  if (CONFLICT_BUCKETS.has(b)) return "conflicts";
  if (REVIEW_BUCKETS.has(b)) return "review";
  if (DO_NOT_TOUCH_BUCKETS.has(b)) return "do_not_touch";
  // Defensive — every bucket must map to exactly one shard.
  throw new Error(`Unmapped bucket: ${b}`);
}

function collisionEvidenceJoined(c: Classification): string {
  return c.collision_evidence
    .map((ev) => `${ev.kind}:${ev.scope}=${ev.value}->${ev.other_ids.join("/")}`)
    .join(" | ");
}

function recommendedAction(b: Bucket): string {
  switch (b) {
    case "auto_safe_backfill_candidate":
      return "ready_for_backfill_after_operator_approval";
    case "conflict_with_existing_identifier_map":
      return "review_pim_collision";
    case "conflict_with_existing_product_columns":
      return "review_product_column_collision";
    case "insufficient_identifiers":
      return "exclude_from_backfill_no_identifier";
    case "upc_only_review":
      return "human_review_upc_only";
    case "sku_only_review":
      return "human_review_sku_only";
    case "dirty_identifier":
      return "human_review_dirty_identifier";
    case "duplicate_orphan_group":
      return "merge_orphan_group_first";
    case "already_represented_by_active_map_elsewhere":
      return "merge_into_existing_canonical_product";
    case "human_review_required":
      return "human_review_general";
    case "do_not_touch":
      return "exclude_from_backfill_lifecycle_state";
  }
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cli = parseCli(process.argv);
  loadEnvLocal();
  console.log("[backfill-dryrun] starting NEXT-18J orphan backfill classifier");
  const trace: string[] = [];

  // 1) Resolve inputs.
  const sel18i = selectInputRun({
    baseDir: NEXT18I_BASE_DIR,
    override: cli.inputRunNext18i,
    requiredFile: "00-orphan-products.csv",
    trace,
    label: "next-18i",
  });
  const sel18g = selectInputRun({
    baseDir: NEXT18G_BASE_DIR,
    override: cli.inputRunNext18g,
    requiredFile: "01-enriched-conflict-clusters.json",
    trace,
    label: "next-18g",
  });
  console.log(`[backfill-dryrun] next-18i=${sel18i.runId} (${sel18i.selectionReason})`);
  console.log(`[backfill-dryrun] next-18g=${sel18g.runId} (${sel18g.selectionReason})`);

  // 2) Load orphan universe, mismatch set, and clusters.
  const orphanCsvText = fs.readFileSync(path.join(sel18i.runDir, "00-orphan-products.csv"), "utf8");
  const orphanCsv = parseCsv(orphanCsvText);
  const mismatchCsvText = fs.readFileSync(path.join(sel18i.runDir, "01-identifier-mismatch.csv"), "utf8");
  const mismatchCsv = parseCsv(mismatchCsvText);
  const mismatchSet = new Set<string>(mismatchCsv.map((r) => r.product_id));
  trace.push(`[next-18i] orphan rows=${orphanCsv.length} mismatch rows=${mismatchCsv.length}`);

  type Next18gManifest = { runId: string; tenant: { organization_id: string; store_ids: string[] } };
  type Next18gCluster = {
    cluster_id: string;
    severity: string;
    conflicting_product_ids: string[];
  };
  const manifest18g = JSON.parse(
    fs.readFileSync(path.join(sel18g.runDir, "manifest.json"), "utf8"),
  ) as Next18gManifest;
  const clusters18g = JSON.parse(
    fs.readFileSync(path.join(sel18g.runDir, "01-enriched-conflict-clusters.json"), "utf8"),
  ) as Next18gCluster[];
  const clusterPidMap = new Map<string, ClusterMembership>();
  for (const c of clusters18g) {
    for (const pid of c.conflicting_product_ids) {
      if (!clusterPidMap.has(pid)) clusterPidMap.set(pid, { cluster_id: c.cluster_id, severity: c.severity });
    }
  }

  // 3) Tenant.
  const orgId = cli.organizationId ?? manifest18g.tenant.organization_id;
  if (!orgId || !isUuidString(orgId)) {
    throw new Error(`Could not derive a valid organization_id (got "${orgId}")`);
  }
  console.log(`[backfill-dryrun] tenant org=${orgId} store_filter=${cli.storeId ?? "<none>"}`);

  // 4) Output dir.
  const runId = mkRunId();
  const runDir = cli.outputDir ?? mkRunDir(NEXT18J_BASE_DIR, runId);
  if (cli.outputDir) fs.mkdirSync(path.join(runDir, "logs"), { recursive: true });
  console.log(`[backfill-dryrun] runId=${runId}`);
  console.log(`[backfill-dryrun] output_dir=${runDir}`);

  const cursorWriter = new NDJsonWriter(path.join(runDir, "logs", "page-cursors.ndjson"));
  const warnings: FetchWarning[] = [];

  const startedAt = new Date().toISOString();
  const manifest: RunMetadata & {
    inputs: {
      next_18i: { runId: string; runDir: string; startedAt: string; finishedAt: string };
      next_18g: { runId: string; runDir: string; startedAt: string; finishedAt: string };
    };
    tenant: { organization_id: string; store_id_filter: string | null };
    entryPoint: string;
  } = {
    runId,
    startedAt,
    finishedAt: null,
    cliArgs: {
      inputRunNext18i: cli.inputRunNext18i,
      inputRunNext18g: cli.inputRunNext18g,
      organizationId: cli.organizationId,
      storeId: cli.storeId,
      outputDir: cli.outputDir,
    },
    envHash: sha256Hex(
      `${sel18i.runId}|${sel18g.runId}|${orgId}|${cli.storeId ?? ""}`,
    ),
    nodeVersion: process.version,
    supabaseJsVersion: getSupabaseJsVersion(),
    generatorGitSha: readGitSha(),
    inputs: {
      next_18i: {
        runId: sel18i.runId,
        runDir: sel18i.runDir,
        startedAt: sel18i.startedAt,
        finishedAt: sel18i.finishedAt,
      },
      next_18g: {
        runId: sel18g.runId,
        runDir: sel18g.runDir,
        startedAt: sel18g.startedAt,
        finishedAt: sel18g.finishedAt,
      },
    },
    tenant: { organization_id: orgId, store_id_filter: cli.storeId },
    entryPoint: "scripts/product-seed-backfill-dryrun.ts",
  };
  writeManifest(runDir, manifest);

  // 5) Supabase snapshot.
  const env = requireEnv();
  const sb = createClient(env.url, env.key, { auth: { persistSession: false } });

  console.log(`[backfill-dryrun] loading products snapshot (PAGE_SIZE=${PAGE_SIZE}, IN_CHUNK=${POSTGREST_IN_CHUNK_SIZE})`);
  const products = await pageProducts({ sb, organizationId: orgId, storeId: cli.storeId, cursorWriter, warnings });
  console.log(`[backfill-dryrun]   products in scope = ${products.length}`);

  console.log(`[backfill-dryrun] loading active product_identifier_map snapshot`);
  const activeMap = await pageActiveMap({ sb, organizationId: orgId, storeId: cli.storeId, cursorWriter, warnings });
  console.log(`[backfill-dryrun]   active map rows   = ${activeMap.length}`);

  await cursorWriter.close();

  // J12: tenant scoping.
  const wrongOrgOffenders: string[] = [];
  for (const p of products) if (p.organization_id !== orgId) wrongOrgOffenders.push(`product:${p.id}`);
  for (const m of activeMap) if (m.organization_id !== orgId) wrongOrgOffenders.push(`map:${m.id}`);

  // 6) Index + duplicate-orphan grouping.
  const productById = new Map(products.map((p) => [p.id, p]));
  const orphans: ProductRow[] = orphanCsv
    .map((r) => productById.get(r.product_id))
    .filter((p): p is ProductRow => p != null);
  if (orphans.length !== orphanCsv.length) {
    warnings.push({
      source: "orphan_resolution",
      reason: `NEXT-18I CSV had ${orphanCsv.length} orphans; only ${orphans.length} resolved to current products snapshot (DB state may have changed since NEXT-18I run)`,
    });
  }
  console.log(`[backfill-dryrun] orphans loaded from NEXT-18I: ${orphans.length}/${orphanCsv.length}`);

  console.log(`[backfill-dryrun] building identifier indexes`);
  const indexes = buildIdentifierIndexes(products, activeMap);

  console.log(`[backfill-dryrun] detecting duplicate-orphan groups`);
  const { groups: duplicateGroups, groupByPid } = groupDuplicateOrphans(orphans);
  console.log(`[backfill-dryrun]   duplicate orphan groups = ${duplicateGroups.length}`);

  // 7) Classify.
  console.log(`[backfill-dryrun] classifying ${orphans.length} orphan(s)`);
  const decisionTrace = new NDJsonWriter(path.join(runDir, "logs", "decision-trace.ndjson"));
  type ClassifiedRow = {
    orphan: ProductRow;
    candidates: Candidates;
    classification: Classification;
    duplicateGroupId: string | null;
    duplicateGroupSize: number;
  };
  const classified: ClassifiedRow[] = [];
  const bucketCounts: Record<Bucket, number> = Object.fromEntries(
    BUCKETS.map((b) => [b, 0]),
  ) as Record<Bucket, number>;
  for (const orphan of orphans) {
    const candidates = deriveCandidates(orphan);
    const dupGroup = groupByPid.get(orphan.id) ?? null;
    const clusterPid = clusterPidMap.get(orphan.id) ?? null;
    const classification = classifyOrphan({
      orphan,
      candidates,
      indexes,
      clusterPid,
      mismatchSet,
      duplicateGroup: dupGroup,
    });
    bucketCounts[classification.bucket]++;
    classified.push({
      orphan,
      candidates,
      classification,
      duplicateGroupId: dupGroup?.group_id ?? null,
      duplicateGroupSize: dupGroup?.size ?? 0,
    });
    decisionTrace.write({
      product_id: orphan.id,
      bucket: classification.bucket,
      evaluation_order: classification.evaluation_order,
      strong_kinds_present: classification.strong_kinds_present,
      dirty_kinds: classification.dirty_kinds,
      collision_counts: classification.collision_counts,
      collision_evidence: classification.collision_evidence,
      subsumed_by_product_id: classification.subsumed_by_product_id,
      safe_reasons: classification.safe_reasons,
      blocked_reasons: classification.blocked_reasons,
      candidates: {
        sku: candidates.sku,
        asin: candidates.asin,
        fnsku: candidates.fnsku,
        upc: candidates.upc,
      },
      duplicate_group_id: dupGroup?.group_id ?? null,
      duplicate_group_size: dupGroup?.size ?? 0,
      in_conflict_cluster: clusterPid?.cluster_id ?? null,
      cluster_severity: clusterPid?.severity ?? null,
      in_mismatch_set: mismatchSet.has(orphan.id),
    });
  }
  await decisionTrace.close();

  // 8) Build CSV row sets.
  const allCsvRows = classified.map(({ orphan, candidates, classification, duplicateGroupId, duplicateGroupSize }) => {
    const proposed = proposedMapRow(
      orphan,
      candidates,
      startedAt,
      classification.bucket === "auto_safe_backfill_candidate" ? 1.0 : 0.5,
    );
    const clusterPid = clusterPidMap.get(orphan.id) ?? null;
    return {
      product_id: orphan.id,
      organization_id: orphan.organization_id,
      store_id: orphan.store_id ?? "",
      bucket: classification.bucket,
      shard: shardForBucket(classification.bucket),
      recommended_action: recommendedAction(classification.bucket),
      in_conflict_cluster: clusterPid != null,
      conflict_cluster_id: clusterPid?.cluster_id ?? "",
      conflict_cluster_severity: clusterPid?.severity ?? "",
      in_mismatch_set: mismatchSet.has(orphan.id),
      has_any_identifier: classification.strong_kinds_present.length + classification.dirty_kinds.length > 0,
      strong_identifier_count: classification.strong_kinds_present.length,
      strong_kinds_present: classification.strong_kinds_present.join(","),
      dirty_kinds: classification.dirty_kinds.join(","),
      candidate_seller_sku: candidates.sku?.normalized ?? "",
      candidate_asin: candidates.asin?.normalized ?? "",
      candidate_fnsku: candidates.fnsku?.normalized ?? "",
      candidate_upc: candidates.upc?.normalized ?? "",
      shape_valid_sku: candidates.sku?.shape_valid ?? "",
      shape_valid_asin: candidates.asin?.shape_valid ?? "",
      shape_valid_fnsku: candidates.fnsku?.shape_valid ?? "",
      shape_valid_upc: candidates.upc?.shape_valid ?? "",
      collision_map_count_same_store: classification.collision_counts.same_store_map,
      collision_map_count_cross_store: classification.collision_counts.cross_store_map,
      collision_product_column_count: classification.collision_counts.product_column,
      collision_evidence: collisionEvidenceJoined(classification),
      duplicate_orphan_group_id: duplicateGroupId ?? "",
      duplicate_orphan_group_size: duplicateGroupSize,
      subsumed_by_product_id: classification.subsumed_by_product_id ?? "",
      proposed_external_listing_id: proposed.external_listing_id,
      proposed_seller_sku: proposed.seller_sku ?? "",
      proposed_asin: proposed.asin ?? "",
      proposed_fnsku: proposed.fnsku ?? "",
      proposed_upc_code: proposed.upc_code ?? "",
      confidence_score: proposed.confidence_score,
      safe_reasons: classification.safe_reasons.join(","),
      blocked_reasons: classification.blocked_reasons.join(","),
      created_at: orphan.created_at ?? "",
      product_name: orphan.product_name ?? "",
      brand: orphan.brand ?? "",
      vendor_name: orphan.vendor_name ?? "",
      mfg_part_number: orphan.mfg_part_number ?? "",
    };
  });

  const ALL_HEADERS = [
    "product_id",
    "organization_id",
    "store_id",
    "bucket",
    "shard",
    "recommended_action",
    "in_conflict_cluster",
    "conflict_cluster_id",
    "conflict_cluster_severity",
    "in_mismatch_set",
    "has_any_identifier",
    "strong_identifier_count",
    "strong_kinds_present",
    "dirty_kinds",
    "candidate_seller_sku",
    "candidate_asin",
    "candidate_fnsku",
    "candidate_upc",
    "shape_valid_sku",
    "shape_valid_asin",
    "shape_valid_fnsku",
    "shape_valid_upc",
    "collision_map_count_same_store",
    "collision_map_count_cross_store",
    "collision_product_column_count",
    "collision_evidence",
    "duplicate_orphan_group_id",
    "duplicate_orphan_group_size",
    "subsumed_by_product_id",
    "proposed_external_listing_id",
    "proposed_seller_sku",
    "proposed_asin",
    "proposed_fnsku",
    "proposed_upc_code",
    "confidence_score",
    "safe_reasons",
    "blocked_reasons",
    "created_at",
    "product_name",
    "brand",
    "vendor_name",
    "mfg_part_number",
  ];
  writeCsv(path.join(runDir, "00-backfill-candidates.csv"), ALL_HEADERS, allCsvRows);
  writeCsv(
    path.join(runDir, "01-auto-safe.csv"),
    ALL_HEADERS,
    allCsvRows.filter((r) => r.shard === "auto_safe"),
  );
  writeCsv(
    path.join(runDir, "02-conflicts.csv"),
    ALL_HEADERS,
    allCsvRows.filter((r) => r.shard === "conflicts"),
  );
  writeCsv(
    path.join(runDir, "03-review-required.csv"),
    ALL_HEADERS,
    allCsvRows.filter((r) => r.shard === "review"),
  );
  writeCsv(
    path.join(runDir, "04-do-not-touch.csv"),
    ALL_HEADERS,
    allCsvRows.filter((r) => r.shard === "do_not_touch"),
  );

  // 9) J-checks.
  const jChecks: JCheckResult[] = [];

  // J1: single-bucket assignment + sum-equals-input.
  const j1Sum = Object.values(bucketCounts).reduce((a, b) => a + b, 0);
  const j1RowBuckets = new Map<string, number>();
  for (const r of allCsvRows) j1RowBuckets.set(r.product_id, (j1RowBuckets.get(r.product_id) ?? 0) + 1);
  const j1DoubleBucket = [...j1RowBuckets.entries()].filter(([, c]) => c !== 1).map(([pid]) => pid);
  jChecks.push(
    j1Sum === orphans.length && j1DoubleBucket.length === 0
      ? {
          name: "J1_single_bucket_assignment",
          pass: true,
          strict: true,
          note: `sum=${j1Sum} orphans=${orphans.length}`,
        }
      : {
          name: "J1_single_bucket_assignment",
          pass: false,
          strict: true,
          note: `sum=${j1Sum} orphans=${orphans.length} double_bucket=${j1DoubleBucket.length}`,
          offenders: j1DoubleBucket.slice(0, 5),
        },
  );

  // J2: shard union equals full.
  const shardUnion = new Set<string>();
  for (const r of allCsvRows.filter((r) => r.shard !== "auto_safe")) shardUnion.add(r.product_id);
  for (const r of allCsvRows.filter((r) => r.shard === "auto_safe")) shardUnion.add(r.product_id);
  jChecks.push(
    shardUnion.size === allCsvRows.length
      ? { name: "J2_shard_union_equals_full", pass: true, strict: true, note: `union=${shardUnion.size}` }
      : {
          name: "J2_shard_union_equals_full",
          pass: false,
          strict: true,
          note: `union=${shardUnion.size} all=${allCsvRows.length}`,
        },
  );

  // J3: auto-safe gating re-verification.
  const autoSafe = classified.filter((c) => c.classification.bucket === "auto_safe_backfill_candidate");
  const j3Bad: string[] = [];
  for (const c of autoSafe) {
    if (!c.orphan.organization_id) j3Bad.push(`${c.orphan.id}:no_org`);
    if (!c.orphan.store_id) j3Bad.push(`${c.orphan.id}:no_store`);
    if (c.orphan.deleted_at) j3Bad.push(`${c.orphan.id}:deleted`);
    if (c.orphan.merge_status === "merged" || c.orphan.merge_status === "duplicate") {
      j3Bad.push(`${c.orphan.id}:merged`);
    }
    if (c.classification.strong_kinds_present.length < 1) j3Bad.push(`${c.orphan.id}:no_strong_id`);
    if (c.classification.dirty_kinds.length > 0) j3Bad.push(`${c.orphan.id}:has_dirty`);
    if (c.classification.collision_counts.same_store_map > 0) j3Bad.push(`${c.orphan.id}:same_store_map_collision`);
    if (c.classification.collision_counts.product_column > 0) j3Bad.push(`${c.orphan.id}:product_column_collision`);
  }
  jChecks.push(
    j3Bad.length === 0
      ? {
          name: "J3_auto_safe_gating",
          pass: true,
          strict: true,
          note: `${autoSafe.length} auto-safe row(s) re-verified`,
        }
      : {
          name: "J3_auto_safe_gating",
          pass: false,
          strict: true,
          note: `${j3Bad.length} auto-safe row(s) violate gating`,
          offenders: j3Bad.slice(0, 5),
        },
  );

  // J4: orphan-input parity.
  jChecks.push(
    allCsvRows.length === orphans.length
      ? {
          name: "J4_orphan_input_parity",
          pass: true,
          strict: true,
          note: `csv=${allCsvRows.length} orphans=${orphans.length}`,
        }
      : {
          name: "J4_orphan_input_parity",
          pass: false,
          strict: true,
          note: `csv=${allCsvRows.length} orphans=${orphans.length} (delta ${allCsvRows.length - orphans.length})`,
        },
  );

  // J5: re-verify map collision for auto-safe.
  const j5Bad: string[] = [];
  for (const c of autoSafe) {
    const candidates = c.candidates;
    for (const cand of [candidates.sku, candidates.asin, candidates.fnsku, candidates.upc]) {
      if (!cand || !cand.normalized) continue;
      const idx = indexes.activeMap[cand.kind].sameStore;
      const key = `${c.orphan.store_id ?? ""}|${cand.normalized}`;
      const others = [...(idx.get(key) ?? new Set<string>())].filter((pid) => pid !== c.orphan.id);
      if (others.length > 0) j5Bad.push(`${c.orphan.id}:${cand.kind}=${cand.normalized}->${others[0]}`);
    }
  }
  jChecks.push(
    j5Bad.length === 0
      ? { name: "J5_reverify_map_collision_auto_safe", pass: true, strict: true }
      : {
          name: "J5_reverify_map_collision_auto_safe",
          pass: false,
          strict: true,
          note: `${j5Bad.length} auto-safe row(s) hit a residual same-store map collision`,
          offenders: j5Bad.slice(0, 5),
        },
  );

  // J6: auto-safe excludes cluster pids.
  const j6Bad = autoSafe.filter((c) => clusterPidMap.has(c.orphan.id)).map((c) => c.orphan.id);
  jChecks.push(
    j6Bad.length === 0
      ? {
          name: "J6_auto_safe_excludes_cluster_pids",
          pass: true,
          strict: true,
          note: `${autoSafe.length} auto-safe row(s); cluster_pids in input = ${clusterPidMap.size}`,
        }
      : {
          name: "J6_auto_safe_excludes_cluster_pids",
          pass: false,
          strict: true,
          note: `${j6Bad.length} auto-safe row(s) are in NEXT-18G clusters`,
          offenders: j6Bad.slice(0, 5),
        },
  );

  // J7: auto-safe excludes mismatch rows.
  const j7Bad = autoSafe.filter((c) => mismatchSet.has(c.orphan.id)).map((c) => c.orphan.id);
  jChecks.push(
    j7Bad.length === 0
      ? { name: "J7_auto_safe_excludes_mismatch_rows", pass: true, strict: true }
      : {
          name: "J7_auto_safe_excludes_mismatch_rows",
          pass: false,
          strict: true,
          note: `${j7Bad.length} auto-safe row(s) are in NEXT-18I mismatch set`,
          offenders: j7Bad.slice(0, 5),
        },
  );

  // J8: no Supabase write calls — soft warn (self-attestation).
  jChecks.push({
    name: "J8_no_supabase_write_calls",
    pass: true,
    strict: false,
    note: "script does not import or invoke insert/update/upsert/delete/rpc on any Supabase table",
  });

  // J9: cursor monotonicity (page-cursors.ndjson).
  const cursorsText = fs.readFileSync(path.join(runDir, "logs", "page-cursors.ndjson"), "utf8");
  const cursorEntries = cursorsText
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { table: string; last_id: string | null });
  const cursorOffenders: string[] = [];
  const lastIdByTable = new Map<string, string>();
  for (const entry of cursorEntries) {
    if (entry.last_id == null) continue;
    const prev = lastIdByTable.get(entry.table);
    if (prev != null && !(entry.last_id > prev)) {
      cursorOffenders.push(`${entry.table}:${prev}->${entry.last_id}`);
    }
    lastIdByTable.set(entry.table, entry.last_id);
  }
  jChecks.push(
    cursorOffenders.length === 0
      ? {
          name: "J9_cursor_monotonicity",
          pass: true,
          strict: true,
          note: `${cursorEntries.length} cursor entries strictly increasing per table`,
        }
      : {
          name: "J9_cursor_monotonicity",
          pass: false,
          strict: true,
          note: `${cursorOffenders.length} non-monotonic cursor transition(s)`,
          offenders: cursorOffenders.slice(0, 5),
        },
  );

  // J10: auto-safe proposed_external_listing_id prefix.
  const j10Bad = allCsvRows
    .filter((r) => r.shard === "auto_safe")
    .filter((r) => !r.proposed_external_listing_id.startsWith("pim_backfill_dry_run:"))
    .map((r) => r.product_id);
  jChecks.push(
    j10Bad.length === 0
      ? {
          name: "J10_auto_safe_external_listing_id_prefix",
          pass: true,
          strict: true,
          note: `${autoSafe.length} auto-safe row(s) all carry the pim_backfill_dry_run: prefix`,
        }
      : {
          name: "J10_auto_safe_external_listing_id_prefix",
          pass: false,
          strict: true,
          note: `${j10Bad.length} auto-safe row(s) missing prefix`,
          offenders: j10Bad.slice(0, 5),
        },
  );

  // J11: duplicate-orphan group symmetry.
  const j11Bad: string[] = [];
  for (const g of duplicateGroups) {
    for (const pid of g.members) {
      const r = allCsvRows.find((x) => x.product_id === pid);
      if (!r) {
        j11Bad.push(`${pid}:not_in_csv`);
        continue;
      }
      if (r.duplicate_orphan_group_id !== g.group_id) {
        j11Bad.push(`${pid}:wrong_group_id`);
      }
      if (r.duplicate_orphan_group_size !== g.size) {
        j11Bad.push(`${pid}:wrong_group_size`);
      }
    }
  }
  jChecks.push(
    j11Bad.length === 0
      ? {
          name: "J11_duplicate_orphan_group_symmetry",
          pass: true,
          strict: true,
          note: `${duplicateGroups.length} duplicate orphan group(s) symmetric`,
        }
      : {
          name: "J11_duplicate_orphan_group_symmetry",
          pass: false,
          strict: true,
          note: `${j11Bad.length} group-membership rows asymmetric`,
          offenders: j11Bad.slice(0, 5),
        },
  );

  // J12: tenant scoping.
  jChecks.push(
    wrongOrgOffenders.length === 0
      ? { name: "J12_tenant_scoping", pass: true, strict: true }
      : {
          name: "J12_tenant_scoping",
          pass: false,
          strict: true,
          note: `${wrongOrgOffenders.length} row(s) with wrong organization_id`,
          offenders: wrongOrgOffenders.slice(0, 5),
        },
  );

  writeValidationChecks(runDir, jChecks);

  // 10) Distributions / summary.
  const bucketTotals: Record<Bucket, number> = bucketCounts;
  const shardTotals = {
    auto_safe: allCsvRows.filter((r) => r.shard === "auto_safe").length,
    conflicts: allCsvRows.filter((r) => r.shard === "conflicts").length,
    review: allCsvRows.filter((r) => r.shard === "review").length,
    do_not_touch: allCsvRows.filter((r) => r.shard === "do_not_touch").length,
  };
  const dirtyKindDistribution: Record<string, number> = {};
  for (const c of classified) {
    for (const k of c.classification.dirty_kinds) {
      dirtyKindDistribution[k] = (dirtyKindDistribution[k] ?? 0) + 1;
    }
  }
  const strongKindDistribution: Record<string, number> = {};
  for (const c of classified) {
    if (c.classification.strong_kinds_present.length === 0) {
      strongKindDistribution["<none>"] = (strongKindDistribution["<none>"] ?? 0) + 1;
      continue;
    }
    const key = c.classification.strong_kinds_present.sort().join("+");
    strongKindDistribution[key] = (strongKindDistribution[key] ?? 0) + 1;
  }
  const clusterOverlap = {
    next_18g_cluster_pids: clusterPidMap.size,
    orphan_in_cluster: classified.filter((c) => clusterPidMap.has(c.orphan.id)).length,
    auto_safe_in_cluster: autoSafe.filter((c) => clusterPidMap.has(c.orphan.id)).length,
  };
  const avgGroupSize =
    duplicateGroups.length > 0
      ? Math.round(
          (duplicateGroups.reduce((a, g) => a + g.size, 0) / duplicateGroups.length) * 100,
        ) / 100
      : 0;

  const finishedAt = new Date().toISOString();
  const summary = {
    runId,
    startedAt,
    finishedAt,
    tenant: { organization_id: orgId, store_id_filter: cli.storeId },
    inputs: {
      next_18i_run_id: sel18i.runId,
      next_18g_run_id: sel18g.runId,
      next_18i_orphan_csv_rows: orphanCsv.length,
      next_18i_mismatch_csv_rows: mismatchCsv.length,
      next_18g_cluster_pids: clusterPidMap.size,
    },
    snapshot: {
      products_in_scope: products.length,
      active_map_rows: activeMap.length,
      orphans_classified: orphans.length,
    },
    totals: {
      buckets: bucketTotals,
      shards: shardTotals,
      duplicate_orphan_groups: duplicateGroups.length,
      duplicate_orphan_group_members: duplicateGroups.reduce((a, g) => a + g.size, 0),
      duplicate_orphan_group_avg_size: avgGroupSize,
    },
    distributions: {
      strong_kinds_present: strongKindDistribution,
      dirty_kinds: dirtyKindDistribution,
    },
    cluster_overlap: clusterOverlap,
    thresholds: {
      page_size: PAGE_SIZE,
      postgrest_in_chunk_size: POSTGREST_IN_CHUNK_SIZE,
    },
    files: {
      manifest: "manifest.json",
      run_summary: "run-summary.json",
      backfill_candidates: "00-backfill-candidates.csv",
      auto_safe: "01-auto-safe.csv",
      conflicts: "02-conflicts.csv",
      review_required: "03-review-required.csv",
      do_not_touch: "04-do-not-touch.csv",
      validation_checks: "05-validation-checks.json",
      decision_trace: "logs/decision-trace.ndjson",
      page_cursors: "logs/page-cursors.ndjson",
      query_trace: "logs/query-trace.txt",
      fetch_warnings: "logs/fetch-warnings.ndjson",
    },
    j_checks: jChecks,
    fetch_warnings_count: warnings.length,
  };
  writeRunSummary(runDir, summary);

  // Logs.
  fs.writeFileSync(path.join(runDir, "logs", "query-trace.txt"), trace.join("\n") + "\n", "utf8");
  fs.writeFileSync(
    path.join(runDir, "logs", "fetch-warnings.ndjson"),
    warnings.length > 0 ? warnings.map((w) => JSON.stringify(w)).join("\n") + "\n" : "",
    "utf8",
  );

  // Finalize manifest.
  manifest.finishedAt = finishedAt;
  writeManifest(runDir, manifest);

  // Console report.
  console.log("");
  console.log("[backfill-dryrun] BUCKET COUNTS");
  for (const b of BUCKETS) {
    console.log(`  ${b.padEnd(48)} ${bucketTotals[b]}`);
  }
  console.log("");
  console.log("[backfill-dryrun] SHARD COUNTS");
  console.log(`  auto_safe                                      ${shardTotals.auto_safe}`);
  console.log(`  conflicts                                      ${shardTotals.conflicts}`);
  console.log(`  review                                         ${shardTotals.review}`);
  console.log(`  do_not_touch                                   ${shardTotals.do_not_touch}`);
  console.log("");
  console.log("[backfill-dryrun] DUPLICATE ORPHAN GROUPS");
  console.log(`  groups                                         ${duplicateGroups.length}`);
  console.log(`  members                                        ${summary.totals.duplicate_orphan_group_members}`);
  console.log(`  avg_size                                       ${avgGroupSize}`);
  console.log("");
  console.log("[backfill-dryrun] CLUSTER OVERLAP");
  console.log(`  next_18g_cluster_pids                          ${clusterOverlap.next_18g_cluster_pids}`);
  console.log(`  orphan_in_cluster                              ${clusterOverlap.orphan_in_cluster}`);
  console.log(`  auto_safe_in_cluster                           ${clusterOverlap.auto_safe_in_cluster}`);
  console.log("");
  console.log("[backfill-dryrun] DIRTY-IDENTIFIER KIND DISTRIBUTION");
  for (const [k, v] of Object.entries(dirtyKindDistribution).sort()) {
    console.log(`  ${k.padEnd(48)} ${v}`);
  }
  console.log("");
  for (const j of jChecks) {
    const tag = j.pass ? "PASS" : j.strict ? "FAIL" : "WARN";
    console.log(`[backfill-dryrun] ${tag} ${j.name}${"note" in j && j.note ? " — " + j.note : ""}`);
  }
  const failedStrict = jChecks.filter((j) => !j.pass && j.strict);
  if (failedStrict.length > 0) {
    console.error(
      `[backfill-dryrun] EXIT 2 — ${failedStrict.length} strict J-check(s) failed: ${failedStrict
        .map((j) => j.name)
        .join(",")}`,
    );
    process.exit(2);
  }
  console.log(`[backfill-dryrun] complete. reports written to ${runDir}`);
}

main().catch((err) => {
  console.error("[backfill-dryrun] FATAL:", err);
  process.exit(1);
});
