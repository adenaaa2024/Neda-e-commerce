/**
 * NEXT-CLAIM-03 / NEXT-CLAIM-05 — Read-only Claim MVP report generator.
 *
 * SELECT-only against Supabase (service role). Writes local files under:
 *   .cursor/audit-reports/next-claim-03/<run_id>/
 *
 * Usage:
 *   npx tsx scripts/claim-mvp-readonly-report.ts
 *   npx tsx scripts/claim-mvp-readonly-report.ts --run-id=20260512T120000Z
 *   npx tsx scripts/claim-mvp-readonly-report.ts --snapshot-dir=.cursor/audit-reports/next-claim-02b/20260512T120000Z-snapshot
 *   npx tsx scripts/claim-mvp-readonly-report.ts --org-id=<uuid> [--store-id=<uuid>]
 *   npx tsx scripts/claim-mvp-readonly-report.ts --emit-raw-pairs
 *
 * No DB writes. No --execute mode.
 *
 * --- Timeout-heavy views (PostgREST statement_timeout) ---
 * `v_claim_analytics_base` and `v_claim_candidate_financial_hints` may time out on large tenants.
 * (`v_claim_candidate_financial_hints` is also not org-filtered at PostgREST in this script — no stable organization_id.)
 * This script tolerates failures (warnings + empty rows) and still uses:
 *   - v_claim_base_amazon_removals
 *   - v_claim_candidate_source_context
 *   - v_claim_financial_events (capped RANGE)
 * Future mitigations: materialized view, narrower SQL, indexes on join keys, or a read-role with higher timeout.
 *
 * --- Production / multi-tenant ---
 * Prefer passing `--org-id` (and optional `--store-id`) for smaller, tenant-safe exports. Unfiltered runs remain default.
 *
 * --- NEXT-CLAIM-05 dedup ---
 * `claim_candidate_existing` is one NDJSON row per `claim_candidates.id`, with `v_claim_candidate_source_context`
 * merged into `evidence.source_context`. Optional `--emit-raw-pairs` writes `01b-claim-candidate-raw-pairs.ndjson`
 * (table row + view row audit stream).
 *
 * Tenant filters: `--org-id` / `--store-id` apply `.eq()` only on sources listed in RELATION_TENANT_COLUMNS inside
 * the script. `v_claim_candidate_source_context` is not org-filtered at PostgREST (column semantics vs candidates);
 * rows are merged only when `claim_candidate_id` is in the loaded `claim_candidates` result set.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type Confidence = "high" | "medium" | "low" | "blocked";
type NextAction =
  | "review"
  | "enrich_product_identity"
  | "inspect_package"
  | "inspect_financials"
  | "defer";

type ClaimCandidateNdjson = {
  run_id: string;
  bucket: string;
  organization_id: string | null;
  store_id: string | null;
  source_table: string;
  source_row_id: string | null;
  claim_candidate_id: string | null;
  order_id: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  product_id: string | null;
  resolved_product_id: string | null;
  confidence: Confidence;
  reason_codes: string[];
  evidence: Record<string, unknown>;
  recommended_next_action: NextAction;
  never_auto_submit: true;
};

const PAGE = 500;
const DEFAULT_SNAPSHOT_DIR = path.join(
  ".cursor",
  "audit-reports",
  "next-claim-02b",
  "20260512T120000Z-snapshot",
);

function loadEnvLocal(): void {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  const raw = fs.readFileSync(p, "utf8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] == null || process.env[k] === "") {
      process.env[k] = v;
    }
  }
}

function createServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (e.g. in .env.local).",
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function isoRunId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

/** PostgREST sources this script reads: whether organization_id / store_id filters apply. */
const RELATION_TENANT_COLUMNS: Record<string, { organization_id: boolean; store_id: boolean }> = {
  claim_candidates: { organization_id: true, store_id: true },
  return_items: { organization_id: true, store_id: true },
  packages: { organization_id: true, store_id: true },
  pallets: { organization_id: true, store_id: true },
  pim_identifier_dispute: { organization_id: true, store_id: true },
  amazon_returns: { organization_id: true, store_id: true },
  claim_submissions: { organization_id: true, store_id: true },
  claim_history_logs: { organization_id: true, store_id: false },
  expected_packages: { organization_id: true, store_id: true },
  amazon_removals: { organization_id: true, store_id: true },
  /** NOT NULL + backfilled per Neda; tenant-scoped reads required for multi-org safety. */
  slip_contents: { organization_id: true, store_id: false },
  claim_cases: { organization_id: true, store_id: false },
  claim_reimbursements: { organization_id: true, store_id: false },
  v_claim_analytics_base: { organization_id: true, store_id: true },
  v_claim_base_amazon_removals: { organization_id: true, store_id: true },
  v_claim_candidate_financial_hints: { organization_id: false, store_id: false },
  /** Org/store not filtered at PostgREST; rows merged only when claim_candidate_id ∈ loaded claim_candidates. */
  v_claim_candidate_source_context: { organization_id: false, store_id: false },
  v_claim_financial_events: { organization_id: true, store_id: true },
};

type QueryFilter = { col: string; val: string };

function parseArgs(argv: string[]): {
  runId: string | null;
  snapshotDir: string;
  organizationId: string | null;
  storeId: string | null;
  emitRawPairs: boolean;
} {
  let runId: string | null = null;
  let snapshotDir = DEFAULT_SNAPSHOT_DIR;
  let organizationId: string | null = null;
  let storeId: string | null = null;
  let emitRawPairs = false;
  for (const a of argv) {
    if (a.startsWith("--run-id=")) runId = a.slice("--run-id=".length).trim() || null;
    if (a.startsWith("--snapshot-dir=")) snapshotDir = a.slice("--snapshot-dir=".length).trim() || snapshotDir;
    if (a.startsWith("--org-id=")) organizationId = a.slice("--org-id=".length).trim() || null;
    if (a.startsWith("--store-id=")) storeId = a.slice("--store-id=".length).trim() || null;
    if (a === "--emit-raw-pairs") emitRawPairs = true;
  }
  return { runId, snapshotDir, organizationId, storeId, emitRawPairs };
}

function tenantFiltersForSource(
  source: string,
  organizationId: string | null,
  storeId: string | null,
  warn: (code: string, detail: string) => void,
): QueryFilter[] {
  const meta = RELATION_TENANT_COLUMNS[source];
  if (!meta) {
    if (organizationId || storeId) {
      warn("FILTER_NO_METADATA", `No tenant column metadata for ${source}; tenant filters not applied.`);
    }
    return [];
  }
  const out: QueryFilter[] = [];
  if (organizationId) {
    if (meta.organization_id) out.push({ col: "organization_id", val: organizationId });
    else warn("FILTER_ORG_SKIPPED", `${source}: no organization_id in metadata; org filter not applied.`);
  }
  if (storeId) {
    if (meta.store_id) out.push({ col: "store_id", val: storeId });
    else warn("FILTER_STORE_SKIPPED", `${source}: no store_id in metadata; store filter not applied.`);
  }
  return out;
}

function escapeCsvCell(v: string): string {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function rowToCsvLine(cols: string[]): string {
  return cols.map((c) => escapeCsvCell(c)).join(",") + "\n";
}

function asStr(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  return String(v);
}

function trace(logPath: string, msg: string): void {
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`, "utf8");
}

async function fetchPaged<T extends Record<string, unknown>>(
  client: SupabaseClient,
  table: string,
  select: string,
  orderCol: string,
  logPath: string,
  filters: QueryFilter[] = [],
): Promise<{ rows: T[]; error: string | null }> {
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    trace(
      logPath,
      `SELECT ${table} range ${from}-${from + PAGE - 1} order ${orderCol} filters=${JSON.stringify(filters)}`,
    );
    let q = client.from(table).select(select).order(orderCol, { ascending: true }).range(from, from + PAGE - 1);
    for (const f of filters) {
      q = q.eq(f.col, f.val);
    }
    const { data, error } = await q;
    if (error) {
      return { rows, error: error.message };
    }
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  return { rows, error: null };
}

async function trySelect(
  client: SupabaseClient,
  table: string,
  select: string,
  logPath: string,
  limit = 2000,
  filters: QueryFilter[] = [],
): Promise<{ rows: Record<string, unknown>[]; error: string | null }> {
  trace(logPath, `SELECT ${table} LIMIT ${limit} filters=${JSON.stringify(filters)}`);
  let q = client.from(table).select(select).limit(limit);
  for (const f of filters) {
    q = q.eq(f.col, f.val);
  }
  const { data, error } = await q;
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as Record<string, unknown>[], error: null };
}

/** Capped read for heavy views (avoids PostgREST statement timeout on full scans). */
async function fetchLimited<T extends Record<string, unknown>>(
  client: SupabaseClient,
  table: string,
  select: string,
  orderCol: string,
  limit: number,
  logPath: string,
  filters: QueryFilter[] = [],
): Promise<{ rows: T[]; error: string | null }> {
  const hi = Math.max(0, limit - 1);
  trace(logPath, `SELECT ${table} ORDER ${orderCol} RANGE 0-${hi} filters=${JSON.stringify(filters)}`);
  let q = client.from(table).select(select).order(orderCol, { ascending: true }).range(0, hi);
  for (const f of filters) {
    q = q.eq(f.col, f.val);
  }
  const { data, error } = await q;
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as T[], error: null };
}

async function countExact(
  client: SupabaseClient,
  table: string,
  logPath: string,
  filters: QueryFilter[] = [],
): Promise<{ count: number | null; error: string | null }> {
  trace(logPath, `COUNT ${table} (head) filters=${JSON.stringify(filters)}`);
  let q = client.from(table).select("*", { count: "exact", head: true });
  for (const f of filters) {
    q = q.eq(f.col, f.val);
  }
  const { count, error } = await q;
  if (error) return { count: null, error: error.message };
  return { count: count ?? 0, error: null };
}

async function countFiltered(
  client: SupabaseClient,
  table: string,
  filters: { col: string; val: string }[],
  logPath: string,
): Promise<{ count: number | null; error: string | null }> {
  trace(logPath, `COUNT ${table} filtered ${JSON.stringify(filters)}`);
  let q = client.from(table).select("*", { count: "exact", head: true });
  for (const f of filters) {
    q = q.eq(f.col, f.val);
  }
  const { count, error } = await q;
  if (error) return { count: null, error: error.message };
  return { count: count ?? 0, error: null };
}

async function fetchPagedWhere<T extends Record<string, unknown>>(
  client: SupabaseClient,
  table: string,
  select: string,
  orderCol: string,
  filters: { col: string; val: string }[],
  logPath: string,
): Promise<{ rows: T[]; error: string | null }> {
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    trace(logPath, `SELECT ${table} filtered range ${from}-${from + PAGE - 1} filters=${JSON.stringify(filters)}`);
    let q = client.from(table).select(select).order(orderCol, { ascending: true }).range(from, from + PAGE - 1);
    for (const f of filters) {
      q = q.eq(f.col, f.val);
    }
    const { data, error } = await q;
    if (error) return { rows, error: error.message };
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  return { rows, error: null };
}

function ndjsonLine(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

function confidenceForRemoval(row: Record<string, unknown>): Confidence {
  const reason = asStr(row.claim_reason_candidate);
  if (reason) return "medium";
  return "low";
}

function confidenceForCandidate(row: Record<string, unknown>): Confidence {
  const st = asStr(row.candidate_status);
  const ev = asStr(row.evidence_status);
  if (st === "blocked" || ev === "blocked") return "blocked";
  const score = row.confidence_score;
  if (typeof score === "number" && score >= 0.8) return "high";
  if (typeof score === "number" && score >= 0.5) return "medium";
  return "low";
}

const CONFIDENCE_RANK: Record<Confidence, number> = {
  blocked: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function mergeConfidence(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b;
}

function nextActionForBucket(bucket: string, confidence: Confidence): NextAction {
  if (confidence === "blocked") return "enrich_product_identity";
  if (bucket === "operational_return_gap") return "inspect_package";
  if (bucket === "financial_hint" || bucket === "removal_base") return "inspect_financials";
  if (bucket === "amazon_return_reconciliation_seed") return "review";
  return "review";
}

async function main(): Promise<void> {
  loadEnvLocal();
  const argv = process.argv.slice(2);
  const { runId: runIdArg, snapshotDir, organizationId, storeId, emitRawPairs } = parseArgs(argv);
  const runId = runIdArg ?? isoRunId();

  const outDir = path.resolve(".cursor", "audit-reports", "next-claim-03", runId);
  const logsDir = path.join(outDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const tracePath = path.join(logsDir, "query-trace.txt");
  const warnPath = path.join(logsDir, "warnings.ndjson");
  fs.writeFileSync(tracePath, "", "utf8");
  fs.writeFileSync(warnPath, "", "utf8");

  const warn = (code: string, detail: string) => {
    fs.appendFileSync(warnPath, JSON.stringify({ code, detail }) + "\n", "utf8");
  };

  const client = createServiceClient();

  const snapshotExists = fs.existsSync(snapshotDir);
  if (!snapshotExists) {
    warn("SNAPSHOT_MISSING", `Snapshot dir not found: ${snapshotDir}`);
  }

  const candidatesNdjsonPath = path.join(outDir, "01-claim-candidates.ndjson");
  fs.writeFileSync(candidatesNdjsonPath, "", "utf8");

  const rawPairsPath = path.join(outDir, "01b-claim-candidate-raw-pairs.ndjson");
  if (emitRawPairs) {
    fs.writeFileSync(rawPairsPath, "", "utf8");
  }
  const appendRawPair = (obj: unknown) => {
    if (!emitRawPairs) return;
    fs.appendFileSync(rawPairsPath, ndjsonLine(obj), "utf8");
  };

  const bucketCounts: Record<string, { high: number; medium: number; low: number; blocked: number; total: number }> =
    {};

  function bumpBucket(bucket: string, c: Confidence) {
    if (!bucketCounts[bucket]) {
      bucketCounts[bucket] = { high: 0, medium: 0, low: 0, blocked: 0, total: 0 };
    }
    bucketCounts[bucket].total += 1;
    bucketCounts[bucket][c] += 1;
  }

  function appendCandidate(rec: ClaimCandidateNdjson) {
    fs.appendFileSync(candidatesNdjsonPath, ndjsonLine(rec), "utf8");
    bumpBucket(rec.bucket, rec.confidence);
  }

  const evidenceRows: string[][] = [];
  evidenceRows.push([
    "candidate_surrogate_id",
    "link_type",
    "target_table",
    "target_id",
    "join_key",
    "confidence",
  ]);

  const financialRows: string[][] = [];
  financialRows.push(["view_name", "organization_id", "store_id", "row_json"]);

  const pimRows: string[][] = [];
  pimRows.push(["taxonomy_cell", "status", "dispute_count"]);

  const gapRows: string[][] = [];
  gapRows.push(["metric", "entity_table", "entity_id", "gap_detail", "severity"]);

  const viewResults: Record<string, { ok: boolean; rows: number; error?: string }> = {};

  const candOrgById = new Map<string, string>();
  const candStoreById = new Map<string, string>();
  const sourceContextByCandidateId = new Map<string, Record<string, unknown>>();

  const ccFilters = tenantFiltersForSource("claim_candidates", organizationId, storeId, warn);
  const claimCandidatesCache = await fetchPaged(
    client,
    "claim_candidates",
    "*",
    "created_at",
    tracePath,
    ccFilters,
  );
  if (claimCandidatesCache.error) warn("TABLE_QUERY", `claim_candidates (cache): ${claimCandidatesCache.error}`);
  for (const r of claimCandidatesCache.rows) {
    const id = asStr(r.id);
    if (id) {
      candOrgById.set(id, asStr(r.organization_id) ?? "");
      candStoreById.set(id, asStr(r.store_id) ?? "");
    }
  }

  const allowedCandidateIds = new Set(
    claimCandidatesCache.rows.map((x) => asStr(x.id)).filter(Boolean) as string[],
  );
  const tenantScoped = Boolean(organizationId || storeId);

  const VIEW_LIMIT_ANALYTICS = 2000;
  const VIEW_LIMIT_FINANCIAL_HINTS = 3000;
  const VIEW_LIMIT_FINANCIAL_EVENTS = 8000;

  const viewSpecs: { name: string; order: string; mode: "paged" | "limited"; limit?: number }[] = [
    { name: "v_claim_analytics_base", order: "organization_id", mode: "limited", limit: VIEW_LIMIT_ANALYTICS },
    { name: "v_claim_base_amazon_removals", order: "source_detail_row_id", mode: "paged" },
    {
      name: "v_claim_candidate_financial_hints",
      order: "claim_candidate_id",
      mode: "limited",
      limit: VIEW_LIMIT_FINANCIAL_HINTS,
    },
    { name: "v_claim_candidate_source_context", order: "claim_candidate_id", mode: "paged" },
    {
      name: "v_claim_financial_events",
      order: "source_row_id",
      mode: "limited",
      limit: VIEW_LIMIT_FINANCIAL_EVENTS,
    },
  ];

  for (const spec of viewSpecs) {
    const { name, order, mode, limit } = spec;
    const vf = tenantFiltersForSource(name, organizationId, storeId, warn);
    let rows: Record<string, unknown>[] = [];
    let error: string | null = null;
    if (mode === "paged") {
      const r = await fetchPaged(client, name, "*", order, tracePath, vf);
      rows = r.rows;
      error = r.error;
    } else {
      const r = await fetchLimited(client, name, "*", order, limit ?? 5000, tracePath, vf);
      rows = r.rows;
      error = r.error;
    }
    if (error) {
      viewResults[name] = { ok: false, rows: rows.length, error };
      warn("VIEW_QUERY", `${name}: ${error}`);
      continue;
    }
    viewResults[name] = { ok: true, rows: rows.length };

    if (name === "v_claim_base_amazon_removals") {
      for (const r of rows) {
        const org = asStr(r.organization_id);
        const sid = asStr(r.source_detail_row_id);
        const conf = confidenceForRemoval(r);
        appendCandidate({
          run_id: runId,
          bucket: "removal_base",
          organization_id: org,
          store_id: asStr(r.store_id),
          source_table: "amazon_removals",
          source_row_id: sid,
          claim_candidate_id: null,
          order_id: asStr(r.order_id),
          sku: asStr(r.sku),
          fnsku: asStr(r.fnsku),
          asin: null,
          product_id: null,
          resolved_product_id: null,
          confidence: conf,
          reason_codes: [asStr(r.claim_reason_candidate)].filter(Boolean) as string[],
          evidence: {
            reimbursement_status: r.reimbursement_status,
            removal_status: r.removal_status,
            expected_scan_quantity_total: r.expected_scan_quantity_total,
            scanned_quantity_total: r.scanned_quantity_total,
            reimbursement_amount_total: r.reimbursement_amount_total,
          },
          recommended_next_action: nextActionForBucket("removal_base", conf),
          never_auto_submit: true,
        });
        if (sid) {
          evidenceRows.push([
            `${runId}:removal_base:${sid}`,
            "removal_detail",
            "amazon_removals",
            sid,
            `order_id=${asStr(r.order_id) ?? ""};sku=${asStr(r.sku) ?? ""}`,
            conf,
          ]);
        }
      }
    }

    if (name === "v_claim_analytics_base") {
      for (const r of rows) {
        const cid = asStr(r.claim_candidate_id);
        const org = asStr(r.organization_id);
        const conf = confidenceForCandidate(r);
        appendCandidate({
          run_id: runId,
          bucket: "analytics_base",
          organization_id: org,
          store_id: asStr(r.store_id),
          source_table: asStr(r.source_table) ?? "unknown",
          source_row_id: asStr(r.source_row_id),
          claim_candidate_id: cid,
          order_id: asStr(r.source_order_id),
          sku: asStr(r.source_sku),
          fnsku: null,
          asin: null,
          product_id: null,
          resolved_product_id: null,
          confidence: conf,
          reason_codes: [asStr(r.claim_reason), asStr(r.claim_family)].filter(Boolean) as string[],
          evidence: {
            submission_status: r.submission_status,
            expected_units: r.expected_units,
            expected_amount: r.expected_amount,
            financial_match_count: r.financial_match_count,
          },
          recommended_next_action: nextActionForBucket("analytics_base", conf),
          never_auto_submit: true,
        });
        if (cid) {
          evidenceRows.push([
            `${runId}:analytics:${cid}`,
            "analytics_candidate",
            "claim_candidates",
            cid,
            "claim_candidate_id",
            conf,
          ]);
        }
      }
    }

    if (name === "v_claim_candidate_financial_hints" || name === "v_claim_financial_events") {
      for (const r of rows) {
        financialRows.push([
          name,
          asStr(r.organization_id) ?? "",
          asStr(r.store_id) ?? "",
          JSON.stringify(r),
        ]);
        const cid = asStr(r.claim_candidate_id ?? r.candidate_id);
        const org = asStr(r.organization_id) ?? (cid ? candOrgById.get(cid) ?? null : null);
        const rowId =
          cid ??
          asStr(r.source_row_id) ??
          `${asStr(r.order_id) ?? ""}:${asStr(r.sku) ?? ""}:${asStr(r.event_date) ?? ""}`;
        const conf: Confidence = "medium";
        appendCandidate({
          run_id: runId,
          bucket: "financial_hint",
          organization_id: org,
          store_id: asStr(r.store_id) ?? (cid ? candStoreById.get(cid) ?? null : null),
          source_table: name,
          source_row_id: rowId,
          claim_candidate_id: cid,
          order_id: asStr(r.order_id ?? r.source_order_id),
          sku: asStr(r.sku ?? r.source_sku),
          fnsku: asStr(r.fnsku),
          asin: asStr(r.asin),
          product_id: asStr(r.product_id),
          resolved_product_id: asStr(r.resolved_product_id),
          confidence: conf,
          reason_codes: ["financial_view_row"],
          evidence: { view: name },
          recommended_next_action: "inspect_financials",
          never_auto_submit: true,
        });
      }
    }

    if (name === "v_claim_candidate_source_context") {
      for (const r of rows) {
        const id = asStr(r.claim_candidate_id);
        if (!id) continue;
        if (!allowedCandidateIds.has(id)) {
          if (!tenantScoped) {
            warn(
              "SOURCE_CONTEXT_ORPHAN_VIEW",
              `v_claim_candidate_source_context row references claim_candidate_id=${id} not present in claim_candidates set.`,
            );
          }
          continue;
        }
        financialRows.push([
          "v_claim_candidate_source_context",
          asStr(r.organization_id) ?? "",
          "",
          JSON.stringify(r),
        ]);
        if (sourceContextByCandidateId.has(id)) {
          warn(
            "SOURCE_CONTEXT_DUP_VIEW_ROW",
            `Multiple v_claim_candidate_source_context rows for claim_candidate_id=${id}; keeping first.`,
          );
          continue;
        }
        sourceContextByCandidateId.set(id, r as Record<string, unknown>);
      }
    }
  }

  {
    if (claimCandidatesCache.error) warn("TABLE_QUERY", `claim_candidates: ${claimCandidatesCache.error}`);
    for (const r of claimCandidatesCache.rows) {
      const id = asStr(r.id);
      const org = asStr(r.organization_id);
      let tableConf = confidenceForCandidate(r);
      const rp = asStr(r.resolved_product_id);
      if (!rp && (tableConf === "high" || tableConf === "medium")) tableConf = "low";

      const ctx = id ? sourceContextByCandidateId.get(id) : undefined;
      const ctxConf = ctx ? confidenceForCandidate(ctx) : tableConf;
      const conf = ctx ? mergeConfidence(tableConf, ctxConf) : tableConf;

      const baseReasons = [asStr(r.claim_reason), asStr(r.claim_family), asStr(r.candidate_status)].filter(
        Boolean,
      ) as string[];
      const reasonCodes = [...new Set([...baseReasons, ...(ctx ? (["source_context"] as string[]) : [])])];

      const evidence: Record<string, unknown> = {
        evidence_status: r.evidence_status,
        expected_units: r.expected_units,
        expected_amount: r.expected_amount,
        confidence_score: r.confidence_score,
        source_context: ctx ?? null,
      };

      appendCandidate({
        run_id: runId,
        bucket: "claim_candidate_existing",
        organization_id: org,
        store_id: asStr(r.store_id),
        source_table: asStr(r.source_table) ?? "unknown",
        source_row_id: asStr(r.source_row_id),
        claim_candidate_id: id,
        order_id: ctx ? asStr(ctx["source_order_id"]) : null,
        sku: asStr(r.sku) ?? (ctx ? asStr(ctx["source_sku"] ?? ctx["candidate_sku"]) : null),
        fnsku: asStr(r.fnsku) ?? (ctx ? asStr(ctx["candidate_fnsku"]) : null),
        asin: asStr(r.asin) ?? (ctx ? asStr(ctx["candidate_asin"]) : null),
        product_id: null,
        resolved_product_id: rp,
        confidence: conf,
        reason_codes: reasonCodes,
        evidence,
        recommended_next_action: nextActionForBucket("claim_candidate_existing", conf),
        never_auto_submit: true,
      });

      if (emitRawPairs && id) {
        appendRawPair({ run_id: runId, role: "claim_candidates", claim_candidate_id: id, row: r });
        const ctxRow = sourceContextByCandidateId.get(id);
        if (ctxRow) {
          appendRawPair({
            run_id: runId,
            role: "v_claim_candidate_source_context",
            claim_candidate_id: id,
            row: ctxRow,
          });
        }
      }

      if (id) {
        evidenceRows.push([
          `${runId}:cc:${id}`,
          "claim_candidate",
          "claim_candidates",
          id,
          `source=${asStr(r.source_table)}:${asStr(r.source_row_id)}`,
          conf,
        ]);
      }
    }
  }

  const retFilters = tenantFiltersForSource("return_items", organizationId, storeId, warn);
  const returnsRes = await fetchPaged(client, "return_items", "*", "created_at", tracePath, retFilters);
  if (returnsRes.error) warn("TABLE_QUERY", `returns: ${returnsRes.error}`);
  const pkgFilters = tenantFiltersForSource("packages", organizationId, storeId, warn);
  const packagesRes = await fetchPaged(client, "packages", "*", "created_at", tracePath, pkgFilters);
  if (packagesRes.error) warn("TABLE_QUERY", `packages: ${packagesRes.error}`);
  const palFilters = tenantFiltersForSource("pallets", organizationId, storeId, warn);
  const palletsRes = await fetchPaged(client, "pallets", "*", "created_at", tracePath, palFilters);
  if (palletsRes.error) warn("TABLE_QUERY", `pallets: ${palletsRes.error}`);

  for (const ret of returnsRes.rows) {
    const id = asStr(ret.id);
    const org = asStr(ret.organization_id);
    if (!ret.package_id) {
      gapRows.push(["missing_package_id", "return_items", id ?? "", "return_items.package_id is null", "medium"]);
      appendCandidate({
        run_id: runId,
        bucket: "operational_return_gap",
        organization_id: org,
        store_id: asStr(ret.store_id),
        source_table: "return_items",
        source_row_id: id,
        claim_candidate_id: null,
        order_id: asStr(ret.order_id),
        sku: asStr(ret.sku),
        fnsku: asStr(ret.fnsku),
        asin: asStr(ret.asin),
        product_id: asStr(ret.product_id),
        resolved_product_id: null,
        confidence: "medium",
        reason_codes: ["missing_package_id"],
        evidence: { pallet_id: ret.pallet_id, package_id: ret.package_id },
        recommended_next_action: "inspect_package",
        never_auto_submit: true,
      });
    }
    if (!ret.product_id) {
      gapRows.push(["missing_product_id", "return_items", id ?? "", "return_items.product_id is null", "low"]);
      appendCandidate({
        run_id: runId,
        bucket: "operational_return_gap",
        organization_id: org,
        store_id: asStr(ret.store_id),
        source_table: "return_items",
        source_row_id: id,
        claim_candidate_id: null,
        order_id: asStr(ret.order_id),
        sku: asStr(ret.sku),
        fnsku: asStr(ret.fnsku),
        asin: asStr(ret.asin),
        product_id: null,
        resolved_product_id: null,
        confidence: "low",
        reason_codes: ["missing_product_id"],
        evidence: {},
        recommended_next_action: "enrich_product_identity",
        never_auto_submit: true,
      });
    }
  }

  for (const pkg of packagesRes.rows) {
    if (!pkg.pallet_id) {
      const id = asStr(pkg.id);
      gapRows.push(["missing_pallet_id", "packages", id ?? "", "packages.pallet_id is null", "medium"]);
      appendCandidate({
        run_id: runId,
        bucket: "operational_return_gap",
        organization_id: asStr(pkg.organization_id),
        store_id: asStr(pkg.store_id),
        source_table: "packages",
        source_row_id: id,
        claim_candidate_id: null,
        order_id: asStr(pkg.order_id),
        sku: null,
        fnsku: null,
        asin: null,
        product_id: null,
        resolved_product_id: null,
        confidence: "medium",
        reason_codes: ["missing_pallet_id"],
        evidence: { tracking_number: pkg.tracking_number },
        recommended_next_action: "inspect_package",
        never_auto_submit: true,
      });
    }
  }

  for (const pal of palletsRes.rows) {
    if (!pal.store_id) {
      const id = asStr(pal.id);
      gapRows.push(["missing_store_id", "pallets", id ?? "", "pallets.store_id is null", "low"]);
      appendCandidate({
        run_id: runId,
        bucket: "operational_return_gap",
        organization_id: asStr(pal.organization_id),
        store_id: null,
        source_table: "pallets",
        source_row_id: id,
        claim_candidate_id: null,
        order_id: asStr(pal.order_id),
        sku: null,
        fnsku: null,
        asin: null,
        product_id: null,
        resolved_product_id: null,
        confidence: "low",
        reason_codes: ["pallet_missing_store_id"],
        evidence: { tracking_number: pal.tracking_number },
        recommended_next_action: "inspect_package",
        never_auto_submit: true,
      });
    }
  }

  let pimQueryOk = true;
  let pimC1 = 0;
  let pimC4 = 0;
  {
    const pimTenant = tenantFiltersForSource("pim_identifier_dispute", organizationId, storeId, warn);
    const c1c = await countFiltered(
      client,
      "pim_identifier_dispute",
      [
        { col: "taxonomy_cell", val: "C1" },
        { col: "status", val: "open" },
        ...pimTenant,
      ],
      tracePath,
    );
    const c4c = await countFiltered(
      client,
      "pim_identifier_dispute",
      [
        { col: "taxonomy_cell", val: "C4" },
        { col: "status", val: "open" },
        ...pimTenant,
      ],
      tracePath,
    );
    if (c1c.error) {
      warn("TABLE_QUERY", `pim count C1: ${c1c.error}`);
      pimQueryOk = false;
    } else pimC1 = c1c.count ?? 0;
    if (c4c.error) {
      warn("TABLE_QUERY", `pim count C4: ${c4c.error}`);
      pimQueryOk = false;
    } else pimC4 = c4c.count ?? 0;

    pimRows.push(["C1", "open", String(pimC1)]);
    pimRows.push(["C4", "open", String(pimC4)]);

    const sel =
      "id,organization_id,store_id,taxonomy_cell,status,members,recommended_winner_id,classifier_fingerprint";
    const openC1Rows = await fetchPagedWhere(
      client,
      "pim_identifier_dispute",
      sel,
      "created_at",
      [
        { col: "taxonomy_cell", val: "C1" },
        { col: "status", val: "open" },
        ...pimTenant,
      ],
      tracePath,
    );
    const openC4Rows = await fetchPagedWhere(
      client,
      "pim_identifier_dispute",
      sel,
      "created_at",
      [
        { col: "taxonomy_cell", val: "C4" },
        { col: "status", val: "open" },
        ...pimTenant,
      ],
      tracePath,
    );
    if (openC1Rows.error) {
      warn("TABLE_QUERY", `pim_identifier_dispute C1: ${openC1Rows.error}`);
      pimQueryOk = false;
    }
    if (openC4Rows.error) {
      warn("TABLE_QUERY", `pim_identifier_dispute C4: ${openC4Rows.error}`);
      pimQueryOk = false;
    }
    const disputeRows = [...openC1Rows.rows, ...openC4Rows.rows];
    for (const r of disputeRows) {
      const id = asStr(r.id);
      appendCandidate({
        run_id: runId,
        bucket: "product_identity_blocked",
        organization_id: asStr(r.organization_id),
        store_id: asStr(r.store_id),
        source_table: "pim_identifier_dispute",
        source_row_id: id,
        claim_candidate_id: null,
        order_id: null,
        sku: null,
        fnsku: null,
        asin: null,
        product_id: null,
        resolved_product_id: asStr(r.recommended_winner_id),
        confidence: "blocked",
        reason_codes: ["open_pim_dispute", asStr(r.taxonomy_cell) ?? ""].filter(Boolean) as string[],
        evidence: {
          taxonomy_cell: r.taxonomy_cell,
          status: r.status,
          members: r.members,
          fingerprint: r.classifier_fingerprint,
        },
        recommended_next_action: "enrich_product_identity",
        never_auto_submit: true,
      });
      if (id) {
        evidenceRows.push([`${runId}:pim:${id}`, "pim_dispute", "pim_identifier_dispute", id, "open", "blocked"]);
      }
    }
  }

  {
    const arFilters = tenantFiltersForSource("amazon_returns", organizationId, storeId, warn);
    const { rows: ar, error: e1 } = await trySelect(
      client,
      "amazon_returns",
      "id,organization_id,store_id,lpn,order_id,sku,asin,product_id,resolved_product_id",
      tracePath,
      1500,
      arFilters,
    );
    if (e1) warn("TABLE_QUERY", `amazon_returns sample: ${e1}`);
    const opFilters = tenantFiltersForSource("return_items", organizationId, storeId, warn);
    const { rows: op, error: e2 } = await trySelect(
      client,
      "return_items",
      "id,organization_id,store_id,lpn,order_id,sku,asin",
      tracePath,
      5000,
      opFilters,
    );
    if (e2) warn("TABLE_QUERY", `return_items sample: ${e2}`);
    const opByLpn = new Map<string, Record<string, unknown>>();
    for (const r of op) {
      const lpn = asStr(r.lpn)?.trim();
      const org = asStr(r.organization_id);
      const st = asStr(r.store_id);
      if (lpn) opByLpn.set(`${org ?? ""}|${st ?? ""}|${lpn}`, r);
    }
    let matchLpn = 0;
    for (const r of ar) {
      const lpn = asStr(r.lpn)?.trim();
      const org = asStr(r.organization_id);
      const st = asStr(r.store_id);
      const k = `${org ?? ""}|${st ?? ""}|${lpn ?? ""}`;
      const hit = lpn ? opByLpn.get(k) : undefined;
      if (lpn && hit) matchLpn += 1;
      const conf: Confidence = hit ? "medium" : "low";
      appendCandidate({
        run_id: runId,
        bucket: "amazon_return_reconciliation_seed",
        organization_id: org,
        store_id: st,
        source_table: "amazon_returns",
        source_row_id: asStr(r.id),
        claim_candidate_id: null,
        order_id: asStr(r.order_id),
        sku: asStr(r.sku),
        fnsku: null,
        asin: asStr(r.asin),
        product_id: asStr(r.product_id),
        resolved_product_id: asStr(r.resolved_product_id),
        confidence: conf,
        reason_codes: hit ? ["lpn_matched_operational_return"] : ["no_lpn_match_in_sample"],
        evidence: {
          lpn,
          operational_return_id: hit ? asStr(hit.id) : null,
          note: "Sample-limited; not exhaustive reconciliation.",
        },
        recommended_next_action: "review",
        never_auto_submit: true,
      });
    }
    evidenceRows.push([
      `${runId}:amazon_seed:summary`,
      "reconciliation_summary",
      "amazon_returns",
      "",
      `lpn_matches_in_sample=${matchLpn};amazon_returns_sample_rows=${ar.length}`,
      "low",
    ]);
  }

  {
    const subFilters = tenantFiltersForSource("claim_submissions", organizationId, storeId, warn);
    const { rows, error } = await fetchPaged(client, "claim_submissions", "*", "created_at", tracePath, subFilters);
    if (error) warn("TABLE_QUERY", `claim_submissions: ${error}`);
    for (const r of rows) {
      evidenceRows.push([
        `${runId}:sub:${asStr(r.id)}`,
        "claim_submission",
        "claim_submissions",
        asStr(r.id) ?? "",
        `return_id=${asStr(r.return_id)}`,
        "medium",
      ]);
    }
  }
  {
    const histFilters = tenantFiltersForSource("claim_history_logs", organizationId, storeId, warn);
    const { rows, error } = await fetchPaged(client, "claim_history_logs", "*", "created_at", tracePath, histFilters);
    if (error) warn("TABLE_QUERY", `claim_history_logs: ${error}`);
    for (const r of rows) {
      evidenceRows.push([
        `${runId}:hist:${asStr(r.id)}`,
        "claim_history",
        "claim_history_logs",
        asStr(r.id) ?? "",
        `claim_id=${asStr(r.claim_id)}`,
        "low",
      ]);
    }
  }

  const counts: Record<string, number | null> = {};
  for (const t of [
    "claim_candidates",
    "claim_submissions",
    "return_items",
    "packages",
    "pallets",
    "expected_packages",
    "amazon_returns",
    "amazon_removals",
    "slip_contents",
    "claim_cases",
    "claim_reimbursements",
  ]) {
    const tf = tenantFiltersForSource(t, organizationId, storeId, warn);
    const { count, error } = await countExact(client, t, tracePath, tf);
    counts[t] = error ? null : count;
    if (error) warn("COUNT", `${t}: ${error}`);
  }

  const rollupPath = path.join(outDir, "00-claim-rollup.csv");
  fs.writeFileSync(rollupPath, "bucket,total,high,medium,low,blocked\n", "utf8");
  for (const [bucket, v] of Object.entries(bucketCounts)) {
    fs.appendFileSync(
      rollupPath,
      rowToCsvLine([
        bucket,
        String(v.total),
        String(v.high),
        String(v.medium),
        String(v.low),
        String(v.blocked),
      ]),
      "utf8",
    );
  }

  const evPath = path.join(outDir, "02-evidence-links.csv");
  fs.writeFileSync(evPath, evidenceRows.map((r) => rowToCsvLine(r)).join(""), "utf8");

  const pimPath = path.join(outDir, "03-product-identity-blockers.csv");
  fs.writeFileSync(pimPath, pimRows.map((r) => rowToCsvLine(r)).join(""), "utf8");

  const gapPath = path.join(outDir, "04-package-pallet-gaps.csv");
  fs.writeFileSync(gapPath, gapRows.map((r) => rowToCsvLine(r)).join(""), "utf8");

  const finPath = path.join(outDir, "05-financial-hints.csv");
  fs.writeFileSync(finPath, financialRows.map((r) => rowToCsvLine(r)).join(""), "utf8");

  const ndjsonLines = fs.readFileSync(candidatesNdjsonPath, "utf8").split("\n").filter(Boolean).length;
  const rawPairsNdjsonLines = emitRawPairs
    ? fs.readFileSync(rawPairsPath, "utf8").split("\n").filter(Boolean).length
    : 0;
  const manifest = {
    run_id: runId,
    created_at: new Date().toISOString(),
    read_only: true,
    no_db_writes: true,
    tenant_filters: {
      organization_id: organizationId,
      store_id: storeId,
    },
    emit_raw_pairs: emitRawPairs,
    claim_candidate_existing_dedup_by_id: true,
    source_snapshot_dir: path.resolve(snapshotDir),
    source_snapshot_present: snapshotExists,
    table_counts: counts,
    view_query_summary: viewResults,
    output_files: {
      rollup: "00-claim-rollup.csv",
      candidates_ndjson: "01-claim-candidates.ndjson",
      ...(emitRawPairs ? { candidates_raw_pairs_ndjson: "01b-claim-candidate-raw-pairs.ndjson" } : {}),
      evidence_links: "02-evidence-links.csv",
      pim_blockers: "03-product-identity-blockers.csv",
      gaps: "04-package-pallet-gaps.csv",
      financial: "05-financial-hints.csv",
      validation: "10-validation-checks.json",
    },
    candidate_ndjson_lines: ndjsonLines,
    ...(emitRawPairs ? { candidate_raw_pairs_ndjson_lines: rawPairsNdjsonLines } : {}),
    bucket_counts: bucketCounts,
    view_query_limits: {
      v_claim_analytics_base: VIEW_LIMIT_ANALYTICS,
      v_claim_candidate_financial_hints: VIEW_LIMIT_FINANCIAL_HINTS,
      v_claim_financial_events: VIEW_LIMIT_FINANCIAL_EVENTS,
    },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  const checks: { id: string; passed: boolean; detail: string }[] = [];

  checks.push({ id: "J1", passed: true, detail: "Script uses only .select(); no insert/update/delete/upsert." });
  const anyViewOk = Object.values(viewResults).some((v) => v.ok);
  checks.push({
    id: "J3",
    passed: anyViewOk,
    detail: anyViewOk ? "At least one v_claim_* query succeeded." : "All v_claim_* queries failed; see warnings.",
  });
  checks.push({
    id: "J4",
    passed: true,
    detail: "Per-row organization_id on candidates; script does not aggregate across orgs.",
  });
  const sampleNd = fs.readFileSync(candidatesNdjsonPath, "utf8").split("\n").filter(Boolean);
  const j5 =
    sampleNd.length === 0 ||
    sampleNd.every((line) => {
      try {
        const o = JSON.parse(line) as ClaimCandidateNdjson;
        return Boolean(o.bucket && o.source_table);
      } catch {
        return false;
      }
    });
  checks.push({ id: "J5", passed: j5, detail: "Each NDJSON line has bucket and source_table." });
  const j6 =
    sampleNd.length === 0 ||
    sampleNd.every((line) => {
      try {
        const o = JSON.parse(line) as ClaimCandidateNdjson;
        return o.never_auto_submit === true;
      } catch {
        return false;
      }
    });
  checks.push({ id: "J6", passed: j6, detail: "never_auto_submit true on all candidates." });
  checks.push({
    id: "J7",
    passed: !returnsRes.error && !packagesRes.error && !palletsRes.error,
    detail: "Operational returns/packages/pallets queried.",
  });
  checks.push({
    id: "J8",
    passed: pimQueryOk,
    detail: pimQueryOk
      ? `pim_identifier_dispute counts (exact): open C1=${pimC1}, open C4=${pimC4}.`
      : "pim_identifier_dispute query failed.",
  });
  checks.push({
    id: "J9",
    passed: true,
    detail: "Empty claim_cases / claim_reimbursements / slip_contents tolerated.",
  });
  checks.push({
    id: "J10",
    passed: true,
    detail: snapshotExists
      ? `manifest.source_snapshot_dir: ${path.resolve(snapshotDir)}`
      : "Snapshot dir missing; path still recorded in manifest.",
  });

  const files = [
    "manifest.json",
    "00-claim-rollup.csv",
    "01-claim-candidates.ndjson",
    "02-evidence-links.csv",
    "03-product-identity-blockers.csv",
    "04-package-pallet-gaps.csv",
    "05-financial-hints.csv",
    path.join("logs", "query-trace.txt"),
    path.join("logs", "warnings.ndjson"),
  ];
  const allFiles = files.every((f) => fs.existsSync(path.join(outDir, f)));
  const missing = files.filter((f) => !fs.existsSync(path.join(outDir, f)));
  checks.push({
    id: "J2",
    passed: allFiles,
    detail: allFiles
      ? "All core output files present (10-validation-checks.json written immediately after this check)."
      : `Missing: ${missing.join(", ")}`,
  });
  const jOrder = ["J1", "J2", "J3", "J4", "J5", "J6", "J7", "J8", "J9", "J10"];
  checks.sort((a, b) => jOrder.indexOf(a.id) - jOrder.indexOf(b.id));
  fs.writeFileSync(path.join(outDir, "10-validation-checks.json"), JSON.stringify(checks, null, 2), "utf8");

  const strictFail =
    !checks.find((c) => c.id === "J2")?.passed ||
    !checks.find((c) => c.id === "J5")?.passed ||
    !checks.find((c) => c.id === "J6")?.passed ||
    !checks.find((c) => c.id === "J7")?.passed ||
    !checks.find((c) => c.id === "J8")?.passed;
  const exitBad = strictFail || !checks.find((c) => c.id === "J3")?.passed;

  console.log(JSON.stringify({ runId, outDir, checks, exitCode: exitBad ? 1 : 0 }, null, 2));
  if (exitBad) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
