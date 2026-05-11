/**
 * NEXT-18G — Product conflict enrichment.
 *
 * Read-only. Takes the NEXT-18F conflict-cluster output (01-conflict-clusters.json)
 * and adds authoritative `products` (and `product_identifier_map`) fields for
 * every `conflicting_product_id`, producing a human-review worksheet.
 *
 * Inputs:
 *   .cursor/audit-reports/next-18f/<runId>/01-conflict-clusters.json
 *   .cursor/audit-reports/next-18f/<runId>/run-summary.json
 *   .cursor/audit-reports/next-18f/<runId>/manifest.json
 *
 * Outputs:
 *   .cursor/audit-reports/next-18g/<runId>/
 *     manifest.json
 *     run-summary.json
 *     00-enriched-conflict-clusters.csv
 *     01-enriched-conflict-clusters.json
 *     02-missing-product-rows.csv
 *     logs/selection-trace.txt
 *     logs/identifier-map-snapshot.ndjson    (unless --no-map-snapshot)
 *     logs/fetch-warnings.ndjson
 *
 * Run:
 *   npx tsx scripts/product-seed-conflict-enrich.ts
 *
 * Optional flags:
 *   --input-run=<runId>
 *   --organization-id=<uuid>
 *   --cluster-id=<id>
 *   --severity-min=<low|medium|high|critical>
 *   --no-map-snapshot
 *   --output-dir=<path>
 *
 * Plan: .cursor/plans/conflict_cluster_enrichment_59211234.plan.md
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
  NDJsonWriter,
  type RunMetadata,
} from "../lib/audits/product-seed-output";
import {
  buildEnrichedCluster,
  chunkIds,
  deriveTenant,
  extractDistinctProductIds,
  HINT_LEVELS,
  loadClustersFromJson,
  SEVERITY_LEVELS,
  type ClusterInput,
  type EnrichedCluster,
  type IdentifierMapSnapshot,
  type LikelyHint,
  type ProductSnapshot,
  type Severity,
} from "../lib/audits/product-seed-conflict-enrich";
import { isUuidString } from "../lib/uuid";

const NEXT18F_BASE_DIR = path.join(".cursor", "audit-reports", "next-18f");
const NEXT18G_BASE_DIR = path.join(".cursor", "audit-reports", "next-18g");
const PRODUCTS_SELECT_COLS = [
  "id",
  "organization_id",
  "store_id",
  "sku",
  "product_name",
  "asin",
  "fnsku",
  "upc_code",
  "mfg_part_number",
  "barcode",
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
  "last_price_updated_at",
  "main_image_url",
  "image_url",
].join(", ");

const IDENTIFIER_MAP_SELECT_COLS = [
  "id",
  "product_id",
  "seller_sku",
  "asin",
  "fnsku",
  "upc_code",
  "store_id",
  "msku",
  "title",
  "source_report_type",
  "match_source",
  "is_primary",
  "first_seen_at",
  "last_seen_at",
].join(", ");

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

type Cli = {
  inputRun: string | null;
  organizationId: string | null;
  clusterId: string | null;
  severityMin: Severity;
  mapSnapshot: boolean;
  outputDir: string | null;
};

function parseCli(argv: string[]): Cli {
  let inputRun: string | null = null;
  let organizationId: string | null = null;
  let clusterId: string | null = null;
  let severityMin: Severity = "low";
  let mapSnapshot = true;
  let outputDir: string | null = null;

  for (const arg of argv.slice(2)) {
    let m: RegExpMatchArray | null;
    if ((m = arg.match(/^--input-run=(.+)$/))) inputRun = m[1].trim() || null;
    else if ((m = arg.match(/^--organization-id=(.+)$/))) organizationId = m[1].trim() || null;
    else if ((m = arg.match(/^--cluster-id=(.+)$/))) clusterId = m[1].trim() || null;
    else if ((m = arg.match(/^--severity-min=(.+)$/))) {
      const v = m[1].trim();
      if (!(SEVERITY_LEVELS as readonly string[]).includes(v)) {
        throw new Error(`Invalid --severity-min=${v}. Allowed: ${SEVERITY_LEVELS.join(",")}`);
      }
      severityMin = v as Severity;
    } else if (arg === "--no-map-snapshot") mapSnapshot = false;
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

  return { inputRun, organizationId, clusterId, severityMin, mapSnapshot, outputDir };
}

function printHelp(): void {
  console.error(
    [
      "Usage: npx tsx scripts/product-seed-conflict-enrich.ts [flags]",
      "",
      "Flags:",
      "  --input-run=<runId>             NEXT-18F run to enrich (default: latest finished)",
      "  --organization-id=<uuid>        Force tenant org (required if multi-org input)",
      "  --cluster-id=<id>               Limit to one cluster (debug)",
      "  --severity-min=<sev>            Skip below threshold (critical|high|medium|low)",
      "  --no-map-snapshot               Skip product_identifier_map SELECT",
      "  --output-dir=<path>             Override default output run directory",
    ].join("\n"),
  );
}

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

type Next18fSelection = {
  runId: string;
  runDir: string;
  startedAt: string;
  finishedAt: string;
  selectionReason: "auto_latest" | "cli_override";
};

function selectInputRun(override: string | null, trace: string[]): Next18fSelection {
  if (!fs.existsSync(NEXT18F_BASE_DIR)) {
    throw new Error(`NEXT-18F base directory not found: ${NEXT18F_BASE_DIR}`);
  }
  type Candidate = { runId: string; runDir: string; startedAt: string; finishedAt: string };
  const candidates: Candidate[] = [];
  const subdirs = fs
    .readdirSync(NEXT18F_BASE_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  trace.push(`[input-run] scanned ${subdirs.length} subdirectories under ${NEXT18F_BASE_DIR}`);
  for (const subdir of subdirs) {
    const runDir = path.join(NEXT18F_BASE_DIR, subdir);
    const manifestPath = path.join(runDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      trace.push(`[input-run] skip ${subdir}: manifest.json missing`);
      continue;
    }
    let manifest: { runId?: string; startedAt?: string; finishedAt?: string | null };
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (e) {
      trace.push(`[input-run] skip ${subdir}: manifest parse error: ${String(e)}`);
      continue;
    }
    if (!manifest.finishedAt) {
      trace.push(`[input-run] skip ${subdir}: finishedAt null`);
      continue;
    }
    if (!fs.existsSync(path.join(runDir, "01-conflict-clusters.json"))) {
      trace.push(`[input-run] skip ${subdir}: 01-conflict-clusters.json missing`);
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
    if (!found) {
      throw new Error(`--input-run=${override} did not match any finished NEXT-18F run`);
    }
    trace.push(`[input-run] override matched runId=${found.runId}`);
    return { ...found, selectionReason: "cli_override" };
  }
  if (candidates.length === 0) {
    throw new Error(`No finished NEXT-18F run found under ${NEXT18F_BASE_DIR}`);
  }
  candidates.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  const chosen = candidates[0];
  trace.push(
    `[input-run] auto-selected runId=${chosen.runId} (${candidates.length} candidate(s), startedAt=${chosen.startedAt})`,
  );
  return { ...chosen, selectionReason: "auto_latest" };
}

type FetchWarning = { source: string; reason: string; detail?: unknown };

async function fetchProducts(
  sb: SupabaseClient,
  ids: string[],
  organizationId: string,
  warnings: FetchWarning[],
): Promise<Map<string, ProductSnapshot>> {
  const out = new Map<string, ProductSnapshot>();
  const chunks = chunkIds(ids);
  console.log(`[enrich] products: requesting ${ids.length} pid(s) in ${chunks.length} chunk(s)`);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const { data, error } = await sb
      .from("products")
      .select(PRODUCTS_SELECT_COLS)
      .eq("organization_id", organizationId)
      .in("id", chunk);
    if (error) {
      warnings.push({
        source: "products",
        reason: `chunk ${i + 1}/${chunks.length} error: ${error.message}`,
        detail: error,
      });
      throw new Error(`[enrich] products chunk ${i + 1} failed: ${error.message}`);
    }
    for (const row of data ?? []) {
      const r = row as Record<string, unknown>;
      const id = String(r.id);
      out.set(id, {
        product_id: id,
        found: true,
        organization_id: stringOrNull(r.organization_id),
        store_id: stringOrNull(r.store_id),
        sku: stringOrNull(r.sku),
        product_name: stringOrNull(r.product_name),
        asin: stringOrNull(r.asin),
        fnsku: stringOrNull(r.fnsku),
        upc_code: stringOrNull(r.upc_code),
        mfg_part_number: stringOrNull(r.mfg_part_number),
        barcode: stringOrNull(r.barcode),
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
        last_price_updated_at: stringOrNull(r.last_price_updated_at),
        main_image_url: stringOrNull(r.main_image_url),
        image_url: stringOrNull(r.image_url),
      });
    }
  }
  return out;
}

async function fetchIdentifierMap(
  sb: SupabaseClient,
  ids: string[],
  organizationId: string,
  warnings: FetchWarning[],
): Promise<Map<string, IdentifierMapSnapshot[]>> {
  const out = new Map<string, IdentifierMapSnapshot[]>();
  if (ids.length === 0) return out;
  const chunks = chunkIds(ids);
  console.log(
    `[enrich] product_identifier_map: requesting rows for ${ids.length} pid(s) in ${chunks.length} chunk(s)`,
  );
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const { data, error } = await sb
      .from("product_identifier_map")
      .select(IDENTIFIER_MAP_SELECT_COLS)
      .eq("organization_id", organizationId)
      .is("deleted_at", null)
      .in("product_id", chunk);
    if (error) {
      warnings.push({
        source: "product_identifier_map",
        reason: `chunk ${i + 1}/${chunks.length} error: ${error.message}`,
        detail: error,
      });
      throw new Error(`[enrich] product_identifier_map chunk ${i + 1} failed: ${error.message}`);
    }
    for (const row of data ?? []) {
      const r = row as Record<string, unknown>;
      const pid = String(r.product_id ?? "");
      if (!pid) continue;
      const entry: IdentifierMapSnapshot = {
        id: String(r.id),
        product_id: pid,
        seller_sku: stringOrNull(r.seller_sku),
        asin: stringOrNull(r.asin),
        fnsku: stringOrNull(r.fnsku),
        upc_code: stringOrNull(r.upc_code),
        store_id: stringOrNull(r.store_id),
        msku: stringOrNull(r.msku),
        title: stringOrNull(r.title),
        source_report_type: stringOrNull(r.source_report_type),
        match_source: stringOrNull(r.match_source),
        is_primary: typeof r.is_primary === "boolean" ? r.is_primary : null,
        first_seen_at: stringOrNull(r.first_seen_at),
        last_seen_at: stringOrNull(r.last_seen_at),
      };
      const list = out.get(pid);
      if (list) list.push(entry);
      else out.set(pid, [entry]);
    }
  }
  return out;
}

function stringOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const t = v.trim();
    return t.length === 0 ? null : t;
  }
  return String(v);
}

function joinPipe(values: Array<string | null | undefined>): string {
  return values.map((v) => (v == null ? "" : v.replace(/\|/g, "/"))).join(" | ");
}

type JCheckResult =
  | { name: string; pass: true; strict: boolean; note?: string }
  | { name: string; pass: false; strict: boolean; note: string; offenders?: unknown[] };

function runJChecks(args: {
  enriched: EnrichedCluster[];
  inputClusters: ClusterInput[];
  productsById: Map<string, ProductSnapshot>;
  identifierMapByProductId: Map<string, IdentifierMapSnapshot[]>;
  requestedPids: Set<string>;
  organizationId: string;
}): JCheckResult[] {
  const { enriched, inputClusters, productsById, identifierMapByProductId, requestedPids, organizationId } = args;
  const results: JCheckResult[] = [];

  const j1Bad: string[] = [];
  for (const c of enriched) {
    const pids = c.conflicting_product_ids;
    const entries = c.enrichment.products;
    if (entries.length !== pids.length) {
      j1Bad.push(`${c.cluster_id}:length_mismatch(${entries.length}!=${pids.length})`);
      continue;
    }
    for (let i = 0; i < pids.length; i++) {
      if (entries[i].product_id !== pids[i]) {
        j1Bad.push(`${c.cluster_id}:order_mismatch_at_${i}`);
        break;
      }
    }
  }
  results.push(
    j1Bad.length === 0
      ? { name: "J1_all_pids_requested_once", pass: true, strict: true }
      : {
          name: "J1_all_pids_requested_once",
          pass: false,
          strict: true,
          note: `${j1Bad.length} cluster(s) have order/length mismatch`,
          offenders: j1Bad.slice(0, 5),
        },
  );

  const j2Bad: string[] = [];
  for (const [pid, snap] of productsById) {
    if (snap.organization_id && snap.organization_id !== organizationId) {
      j2Bad.push(`${pid}:org=${snap.organization_id}`);
    }
  }
  results.push(
    j2Bad.length === 0
      ? { name: "J2_found_products_match_tenant_org", pass: true, strict: true }
      : {
          name: "J2_found_products_match_tenant_org",
          pass: false,
          strict: true,
          note: `${j2Bad.length} returned product(s) have wrong organization_id`,
          offenders: j2Bad.slice(0, 5),
        },
  );

  results.push(
    enriched.length === inputClusters.length
      ? {
          name: "J3_input_cluster_count_preserved",
          pass: true,
          strict: true,
          note: `enriched=${enriched.length} matches input=${inputClusters.length}`,
        }
      : {
          name: "J3_input_cluster_count_preserved",
          pass: false,
          strict: true,
          note: `enriched=${enriched.length} != input=${inputClusters.length}`,
        },
  );

  const j4Bad: string[] = [];
  for (const c of enriched) {
    const stores = new Set<string>();
    for (const e of c.enrichment.products) {
      if (e.snapshot?.store_id) stores.add(e.snapshot.store_id);
    }
    const expected = stores.size >= 2;
    if (expected !== c.enrichment.computed.any_cross_store) {
      j4Bad.push(c.cluster_id);
    }
  }
  results.push(
    j4Bad.length === 0
      ? { name: "J4_cross_store_flagged_not_dropped", pass: true, strict: true }
      : {
          name: "J4_cross_store_flagged_not_dropped",
          pass: false,
          strict: true,
          note: `${j4Bad.length} cluster(s) have wrong any_cross_store flag`,
          offenders: j4Bad.slice(0, 5),
        },
  );

  const j5Bad: string[] = [];
  for (const c of enriched) {
    if (!(HINT_LEVELS as readonly string[]).includes(c.enrichment.computed.likely_same_product_hint)) {
      j5Bad.push(`${c.cluster_id}:${c.enrichment.computed.likely_same_product_hint}`);
    }
  }
  results.push(
    j5Bad.length === 0
      ? { name: "J5_likely_hint_well_typed", pass: true, strict: true }
      : {
          name: "J5_likely_hint_well_typed",
          pass: false,
          strict: true,
          note: `${j5Bad.length} cluster(s) have invalid hint`,
          offenders: j5Bad.slice(0, 5),
        },
  );

  const requested = requestedPids.size;
  const found = productsById.size;
  const missing = requested - found;
  results.push(
    found + missing === requested
      ? {
          name: "J6_missing_pids_reconcile",
          pass: true,
          strict: true,
          note: `requested=${requested} found=${found} missing=${missing}`,
        }
      : {
          name: "J6_missing_pids_reconcile",
          pass: false,
          strict: true,
          note: `requested=${requested} != found(${found})+missing(${missing})`,
        },
  );

  const j7Bad: string[] = [];
  for (const [pid, rows] of identifierMapByProductId) {
    if (!requestedPids.has(pid)) {
      j7Bad.push(pid);
      continue;
    }
    for (const r of rows) {
      if (r.product_id !== pid) j7Bad.push(`${pid}:row_pid_mismatch=${r.product_id}`);
    }
  }
  results.push(
    j7Bad.length === 0
      ? { name: "J7_identifier_map_consistency", pass: true, strict: true }
      : {
          name: "J7_identifier_map_consistency",
          pass: false,
          strict: true,
          note: `${j7Bad.length} identifier_map row(s) reference a pid outside the requested set`,
          offenders: j7Bad.slice(0, 5),
        },
  );

  return results;
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv);
  loadEnvLocal();

  const trace: string[] = [];
  console.log("[enrich] starting NEXT-18G product conflict enrichment");

  const selection = selectInputRun(cli.inputRun, trace);
  console.log(
    `[enrich] input_run=${selection.runId} runDir=${selection.runDir} (${selection.selectionReason})`,
  );

  const clusterJsonPath = path.join(selection.runDir, "01-conflict-clusters.json");
  const allClusters = loadClustersFromJson(clusterJsonPath);
  console.log(`[enrich] loaded ${allClusters.length} cluster(s) from ${clusterJsonPath}`);

  let filteredClusters: ClusterInput[] = allClusters;
  if (cli.clusterId) {
    filteredClusters = filteredClusters.filter((c) => c.cluster_id === cli.clusterId);
    trace.push(`[filter] --cluster-id=${cli.clusterId} kept ${filteredClusters.length} cluster(s)`);
  }
  if (cli.severityMin !== "low") {
    const maxRank = SEVERITY_RANK[cli.severityMin];
    filteredClusters = filteredClusters.filter((c) => SEVERITY_RANK[c.severity] <= maxRank);
    trace.push(
      `[filter] --severity-min=${cli.severityMin} kept ${filteredClusters.length} cluster(s)`,
    );
  }
  if (filteredClusters.length === 0) {
    throw new Error("[enrich] no clusters left after filters; nothing to do");
  }

  const tenant = deriveTenant(filteredClusters, cli.organizationId);
  for (const t of tenant.trace) trace.push(t);
  console.log(
    `[enrich] tenant: organization_id=${tenant.organization_id} store_ids=[${tenant.store_ids.join(",")}]`,
  );

  const requestedPidArr = extractDistinctProductIds(filteredClusters);
  const requestedPids = new Set(requestedPidArr);
  console.log(`[enrich] distinct product_ids to enrich: ${requestedPidArr.length}`);

  const env = requireEnv();
  const sb = createClient(env.url, env.key, { auth: { persistSession: false } });

  const warnings: FetchWarning[] = [];
  const productsById = await fetchProducts(sb, requestedPidArr, tenant.organization_id, warnings);
  console.log(
    `[enrich] products: found ${productsById.size}/${requestedPidArr.length}; missing=${requestedPidArr.length - productsById.size}`,
  );

  const identifierMapByProductId = cli.mapSnapshot
    ? await fetchIdentifierMap(sb, requestedPidArr, tenant.organization_id, warnings)
    : new Map<string, IdentifierMapSnapshot[]>();
  if (cli.mapSnapshot) {
    let totalRows = 0;
    for (const v of identifierMapByProductId.values()) totalRows += v.length;
    console.log(
      `[enrich] product_identifier_map: ${totalRows} row(s) across ${identifierMapByProductId.size} product_id(s)`,
    );
  } else {
    console.log("[enrich] product_identifier_map: skipped (--no-map-snapshot)");
  }

  const enriched: EnrichedCluster[] = filteredClusters.map((c) =>
    buildEnrichedCluster({
      cluster: c,
      productsById,
      identifierMapByProductId,
    }),
  );

  const runId = mkRunId();
  const outputDir = cli.outputDir ?? mkRunDir(NEXT18G_BASE_DIR, runId);
  if (cli.outputDir) fs.mkdirSync(path.join(outputDir, "logs"), { recursive: true });
  console.log(`[enrich] runId=${runId}`);
  console.log(`[enrich] output_dir=${outputDir}`);

  fs.writeFileSync(path.join(outputDir, "logs", "selection-trace.txt"), trace.join("\n") + "\n", "utf8");

  const fetchWarningsPath = path.join(outputDir, "logs", "fetch-warnings.ndjson");
  fs.writeFileSync(
    fetchWarningsPath,
    warnings.length > 0 ? warnings.map((w) => JSON.stringify(w)).join("\n") + "\n" : "",
    "utf8",
  );

  if (cli.mapSnapshot) {
    const ndjsonPath = path.join(outputDir, "logs", "identifier-map-snapshot.ndjson");
    const writer = new NDJsonWriter(ndjsonPath);
    for (const rows of identifierMapByProductId.values()) {
      for (const row of rows) writer.write(row);
    }
    await writer.close();
  }

  const startedAt = new Date().toISOString();
  const manifest: RunMetadata & {
    inputRun: { runId: string; runDir: string; startedAt: string; finishedAt: string };
    tenant: { organization_id: string; store_ids: string[] };
    entryPoint: string;
  } = {
    runId,
    startedAt,
    finishedAt: null,
    cliArgs: {
      inputRun: cli.inputRun,
      organizationId: cli.organizationId,
      clusterId: cli.clusterId,
      severityMin: cli.severityMin,
      mapSnapshot: cli.mapSnapshot,
      outputDir: cli.outputDir,
    },
    envHash: sha256Hex(
      `${selection.runId}|${tenant.organization_id}|${requestedPidArr.length}|${cli.mapSnapshot}`,
    ),
    nodeVersion: process.version,
    supabaseJsVersion: getSupabaseJsVersion(),
    generatorGitSha: readGitSha(),
    inputRun: {
      runId: selection.runId,
      runDir: selection.runDir,
      startedAt: selection.startedAt,
      finishedAt: selection.finishedAt,
    },
    tenant: { organization_id: tenant.organization_id, store_ids: tenant.store_ids },
    entryPoint: "scripts/product-seed-conflict-enrich.ts",
  };
  writeManifest(outputDir, manifest);

  writeCsv(
    path.join(outputDir, "00-enriched-conflict-clusters.csv"),
    [
      "cluster_id",
      "severity",
      "recommended_review_action",
      "severity_reasons",
      "asin",
      "fnsku",
      "seller_sku",
      "source_tables_seen",
      "rows_seen_total",
      "product_ids",
      "vendor_hint",
      "product_titles",
      "product_skus",
      "product_upcs",
      "product_asins",
      "product_fnskus",
      "product_mfg_part_numbers",
      "product_brands",
      "product_vendors",
      "product_statuses",
      "product_deleted_at",
      "product_merged_into_ids",
      "product_store_ids",
      "n_distinct_titles",
      "n_distinct_skus",
      "n_distinct_asins",
      "n_distinct_fnskus",
      "n_distinct_upcs",
      "any_merged",
      "any_deleted",
      "any_cross_store",
      "any_missing",
      "merged_into_inside_cluster",
      "likely_same_product_hint",
      "likely_same_product_reasons",
      "title_similarity_max",
      "review_notes_blank",
    ],
    enriched.map((c) => {
      const products = c.enrichment.products;
      const snapAt = (i: number): ProductSnapshot | null => products[i].snapshot ?? null;
      return {
        cluster_id: c.cluster_id,
        severity: c.severity,
        recommended_review_action: c.recommended_review_action,
        severity_reasons: c.severity_reasons.join(","),
        asin: c.identifiers.asin,
        fnsku: c.identifiers.fnsku,
        seller_sku: c.identifiers.seller_sku,
        source_tables_seen: c.source_tables_seen.join(","),
        rows_seen_total: c.rows_seen_total,
        product_ids: c.conflicting_product_ids.join(","),
        vendor_hint: c.vendor_hint,
        product_titles: joinPipe(
          products.map((_, i) => snapAt(i)?.product_name ?? null),
        ),
        product_skus: joinPipe(products.map((_, i) => snapAt(i)?.sku ?? null)),
        product_upcs: joinPipe(products.map((_, i) => snapAt(i)?.upc_code ?? null)),
        product_asins: joinPipe(products.map((_, i) => snapAt(i)?.asin ?? null)),
        product_fnskus: joinPipe(products.map((_, i) => snapAt(i)?.fnsku ?? null)),
        product_mfg_part_numbers: joinPipe(
          products.map((_, i) => snapAt(i)?.mfg_part_number ?? null),
        ),
        product_brands: joinPipe(products.map((_, i) => snapAt(i)?.brand ?? null)),
        product_vendors: joinPipe(products.map((_, i) => snapAt(i)?.vendor_name ?? null)),
        product_statuses: joinPipe(
          products.map((_, i) => {
            const s = snapAt(i);
            if (!s) return null;
            return `${s.status ?? ""}:${s.merge_status ?? ""}`;
          }),
        ),
        product_deleted_at: joinPipe(products.map((_, i) => snapAt(i)?.deleted_at ?? null)),
        product_merged_into_ids: joinPipe(
          products.map((_, i) => snapAt(i)?.merged_into_id ?? null),
        ),
        product_store_ids: joinPipe(products.map((_, i) => snapAt(i)?.store_id ?? null)),
        n_distinct_titles: c.enrichment.computed.n_distinct_titles,
        n_distinct_skus: c.enrichment.computed.n_distinct_skus,
        n_distinct_asins: c.enrichment.computed.n_distinct_asins,
        n_distinct_fnskus: c.enrichment.computed.n_distinct_fnskus,
        n_distinct_upcs: c.enrichment.computed.n_distinct_upcs,
        any_merged: c.enrichment.computed.any_merged,
        any_deleted: c.enrichment.computed.any_deleted,
        any_cross_store: c.enrichment.computed.any_cross_store,
        any_missing: c.enrichment.computed.any_missing,
        merged_into_inside_cluster: c.enrichment.computed.merged_into_inside_cluster,
        likely_same_product_hint: c.enrichment.computed.likely_same_product_hint,
        likely_same_product_reasons: c.enrichment.computed.likely_same_product_reasons.join(","),
        title_similarity_max:
          c.enrichment.computed.title_similarity_max == null
            ? ""
            : c.enrichment.computed.title_similarity_max.toFixed(3),
        review_notes_blank: "",
      };
    }),
  );

  writeJson(path.join(outputDir, "01-enriched-conflict-clusters.json"), enriched);

  const missingRows: Record<string, unknown>[] = [];
  for (const c of enriched) {
    for (const e of c.enrichment.products) {
      if (e.found) continue;
      missingRows.push({
        cluster_id: c.cluster_id,
        product_id: e.product_id,
        severity: c.severity,
        vendor_hint: c.vendor_hint,
        triad_asin: c.identifiers.asin,
        triad_fnsku: c.identifiers.fnsku,
        triad_seller_sku: c.identifiers.seller_sku,
        seen_in_identifier_map: identifierMapByProductId.has(e.product_id),
        note: "product_id present in conflicting_product_ids but no public.products row matched in organization scope; either hard-deleted product, cross-org reference, or stale identifier_map entry",
      });
    }
  }
  writeCsv(
    path.join(outputDir, "02-missing-product-rows.csv"),
    [
      "cluster_id",
      "product_id",
      "severity",
      "vendor_hint",
      "triad_asin",
      "triad_fnsku",
      "triad_seller_sku",
      "seen_in_identifier_map",
      "note",
    ],
    missingRows,
  );

  const jChecks = runJChecks({
    enriched,
    inputClusters: filteredClusters,
    productsById,
    identifierMapByProductId,
    requestedPids,
    organizationId: tenant.organization_id,
  });

  const hintDistribution: Record<LikelyHint, number> = {
    yes_high: 0,
    yes_medium: 0,
    uncertain: 0,
    no_low: 0,
  };
  const clustersBySeverity: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  let clustersAnyMerged = 0;
  let clustersAnyDeleted = 0;
  let clustersAnyCrossStore = 0;
  let clustersWithMissingProductRows = 0;
  let clustersMergedIntoInside = 0;
  for (const c of enriched) {
    hintDistribution[c.enrichment.computed.likely_same_product_hint]++;
    clustersBySeverity[c.severity]++;
    if (c.enrichment.computed.any_merged) clustersAnyMerged++;
    if (c.enrichment.computed.any_deleted) clustersAnyDeleted++;
    if (c.enrichment.computed.any_cross_store) clustersAnyCrossStore++;
    if (c.enrichment.computed.any_missing) clustersWithMissingProductRows++;
    if (c.enrichment.computed.merged_into_inside_cluster) clustersMergedIntoInside++;
  }

  const finishedAt = new Date().toISOString();
  const summary = {
    runId,
    startedAt,
    finishedAt,
    input_run: selection.runId,
    input_clusters: filteredClusters.length,
    tenant: { organization_id: tenant.organization_id, store_ids: tenant.store_ids },
    totals: {
      product_ids_requested: requestedPidArr.length,
      product_ids_found: productsById.size,
      product_ids_missing: requestedPidArr.length - productsById.size,
      identifier_map_rows_snapshot: countIdentifierMapRows(identifierMapByProductId),
      clusters_enriched: enriched.length,
      clusters_by_severity: clustersBySeverity,
    },
    hint_distribution: hintDistribution,
    signal_counts: {
      clusters_any_merged: clustersAnyMerged,
      clusters_any_deleted: clustersAnyDeleted,
      clusters_any_cross_store: clustersAnyCrossStore,
      clusters_with_missing_product_rows: clustersWithMissingProductRows,
      clusters_merged_into_inside_cluster: clustersMergedIntoInside,
    },
    thresholds: {
      yes_high: "existing_merge_decision OR (single_sku AND single_asin) OR (any_merged AND single_sku)",
      yes_medium: "single_asin AND (single_title OR title_similarity>=0.5), or any_merged alone",
      no_low: "all_distinct_identifiers AND title_similarity<0.2",
      cross_store_caveat: "any cluster spanning >=2 store_ids is downgraded to 'uncertain' unless merged_into_inside_cluster",
    },
    files: {
      manifest: "manifest.json",
      run_summary: "run-summary.json",
      enriched_csv: "00-enriched-conflict-clusters.csv",
      enriched_json: "01-enriched-conflict-clusters.json",
      missing_csv: "02-missing-product-rows.csv",
      selection_trace: "logs/selection-trace.txt",
      identifier_map_snapshot: cli.mapSnapshot ? "logs/identifier-map-snapshot.ndjson" : null,
      fetch_warnings: "logs/fetch-warnings.ndjson",
    },
    j_checks: jChecks,
    fetch_warnings_count: warnings.length,
  };
  writeRunSummary(outputDir, summary);

  manifest.finishedAt = finishedAt;
  writeManifest(outputDir, manifest);

  console.log(
    `[enrich] clusters=${enriched.length} severity=${JSON.stringify(clustersBySeverity)} hints=${JSON.stringify(hintDistribution)}`,
  );
  console.log(
    `[enrich] signals: any_merged=${clustersAnyMerged} any_deleted=${clustersAnyDeleted} any_cross_store=${clustersAnyCrossStore} merged_into_inside=${clustersMergedIntoInside} missing_rows=${clustersWithMissingProductRows}`,
  );
  for (const j of jChecks) {
    const tag = j.pass ? "PASS" : j.strict ? "FAIL" : "WARN";
    console.log(`[enrich] ${tag} ${j.name}${"note" in j && j.note ? " — " + j.note : ""}`);
  }
  const failedStrict = jChecks.filter((j) => !j.pass && j.strict);
  if (failedStrict.length > 0) {
    console.error(
      `[enrich] EXIT 2 — ${failedStrict.length} strict J-check(s) failed: ${failedStrict
        .map((j) => j.name)
        .join(",")}`,
    );
    process.exit(2);
  }
  console.log(`[enrich] complete. reports written to ${outputDir}`);
}

function countIdentifierMapRows(m: Map<string, IdentifierMapSnapshot[]>): number {
  let n = 0;
  for (const v of m.values()) n += v.length;
  return n;
}

main().catch((err) => {
  console.error("[enrich] FATAL:", err);
  process.exit(1);
});
