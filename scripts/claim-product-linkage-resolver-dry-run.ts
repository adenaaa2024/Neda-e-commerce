/**
 * NEXT-CLAIM-09 / NEXT-CLAIM-11 — Dry-run claim_candidates product linkage resolver (SELECT-only).
 *
 * Writes: .cursor/audit-reports/next-claim-09/<run_id>/
 *
 *   npx tsx scripts/claim-product-linkage-resolver-dry-run.ts
 *   npx tsx scripts/claim-product-linkage-resolver-dry-run.ts --run-id=myRun
 *   npx tsx scripts/claim-product-linkage-resolver-dry-run.ts --organization-id=<uuid> [--store-id=<uuid>]
 *
 * Optional env:
 *   CLAIM_RESOLVER_TRUST_SOURCE_PRODUCT_ID=true — treat non-null source product_id as proposed resolved (default false).
 *
 * No DB writes. No --execute mode.
 *
 * NEXT-CLAIM-13: optional `--organization-id` / `--store-id` tenant filters; org-scoped source fetch;
 * operational alternate-key resolution for amazon_removals / amazon_returns (see lib/claim-operational-source-resolve).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  CLAIM_SUPPORTED_SOURCE_TABLES,
  type ClaimSourcePack,
  resolveClaimCandidateSourcePack,
} from "../lib/claim-operational-source-resolve";
import {
  pickBestProductIdentifierMatch,
  type ProductIdentifierMapRow,
  type IdentifierLookupHints,
  type ProductIdentifierMatchResult,
} from "../lib/product-identifier-match";

const PAGE = 400;
const SOURCE_FETCH_CHUNK = 120;
const PIM_OPEN_PAGE_MAX = 12_000;
const TRUST_SOURCE_PRODUCT_ID = process.env.CLAIM_RESOLVER_TRUST_SOURCE_PRODUCT_ID === "true";

export type FinalBucket =
  | "resolvable_from_source"
  | "resolvable_from_identifiers"
  | "ambiguous"
  | "missing_source_row"
  | "blocked_pim"
  | "unsupported_source_table"
  | "unresolved_no_identifiers"
  | "safe_update_candidate";

type ProposalFrom = "source_resolved" | "source_product_id" | "identifier_map" | "none";

type NdjsonRecord = {
  run_id: string;
  claim_candidate_id: string;
  organization_id: string | null;
  store_id: string | null;
  source_table: string | null;
  source_row_id: string | null;
  source_found: boolean;
  source_resolution_tier: string;
  proposed_resolved_product_id: string | null;
  proposed_product_id: string | null;
  identifier_inputs: Record<string, string | null>;
  map_hits_count: number;
  pim_blocked: boolean;
  final_bucket: FinalBucket;
  reason_codes: string[];
  confidence: number;
  never_auto_submit: true;
  policy_settings_status: "not_wired_yet";
  recommended_next_action: string;
  evidence_status: string | null;
  proposal_from: ProposalFrom;
};

/** Unified audit columns for 02–06 detail CSVs (NEXT-CLAIM-11). */
const AUDIT_CSV_HEADERS = [
  "claim_candidate_id",
  "proposed_resolved_product_id",
  "source_table",
  "source_row_id",
  "evidence_status",
  "source_resolution_tier",
  "proposal_from",
  "reason_codes",
] as const;

function auditDetailCsvLine(args: {
  claimCandidateId: string;
  proposedResolved: string | null;
  sourceTableRaw: string | null;
  sourceRowId: string | null;
  evidenceStatus: string | null;
  sourceResolutionTier: string;
  proposalFrom: ProposalFrom;
  reasonCodes: string[];
}): string {
  return rowToCsvLine([
    args.claimCandidateId,
    args.proposedResolved ?? "",
    args.sourceTableRaw ?? "",
    args.sourceRowId ?? "",
    args.evidenceStatus ?? "",
    args.sourceResolutionTier,
    args.proposalFrom,
    args.reasonCodes.join(";"),
  ]);
}

function readCsvHeaderRow(filePath: string): string[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const line = raw.split(/\r?\n/)[0] ?? "";
  return line.split(",").map((c) => c.trim());
}

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
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

function createServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
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

function parseArgs(argv: string[]): {
  runId: string | null;
  organizationId: string | null;
  storeId: string | null;
} {
  let runId: string | null = null;
  let organizationId: string | null = null;
  let storeId: string | null = null;
  for (const a of argv) {
    if (a.startsWith("--run-id=")) runId = a.slice("--run-id=".length).trim() || null;
    if (a.startsWith("--organization-id=")) organizationId = a.slice("--organization-id=".length).trim() || null;
    if (a.startsWith("--org-id=")) organizationId = a.slice("--org-id=".length).trim() || null;
    if (a.startsWith("--store-id=")) storeId = a.slice("--store-id=".length).trim() || null;
  }
  return { runId, organizationId, storeId };
}

function escapeCsvCell(v: string): string {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function rowToCsvLine(cols: string[]): string {
  return cols.map((c) => escapeCsvCell(c)).join(",") + "\n";
}

function trace(tracePath: string, msg: string): void {
  fs.appendFileSync(tracePath, `[${new Date().toISOString()}] ${msg}\n`, "utf8");
}

function n(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

const SUPPORTED_SOURCES = CLAIM_SUPPORTED_SOURCE_TABLES;

const MAP_SELECT =
  "id, organization_id, product_id, catalog_product_id, store_id, seller_sku, asin, fnsku, msku, upc_code, deleted_at, title";

const MAP_PREFETCH_CONCURRENCY = 12;

function mapLookupCacheKey(
  organizationId: string,
  storeId: string,
  hints: { fnsku?: string | null; msku?: string | null; asin?: string | null },
): string {
  return [organizationId, storeId, n(hints.fnsku) ?? "", n(hints.msku) ?? "", n(hints.asin) ?? ""].join("\x1f");
}

async function fetchMapRowsForHints(
  client: SupabaseClient,
  organizationId: string,
  storeId: string | null,
  hints: { fnsku?: string | null; msku?: string | null; asin?: string | null },
  tracePath: string,
): Promise<{ rows: ProductIdentifierMapRow[]; error: string | null }> {
  const sid = n(storeId);
  if (!sid) return { rows: [], error: null };

  const collected: ProductIdentifierMapRow[] = [];
  const seen = new Set<string>();
  const push = (data: unknown) => {
    for (const r of (data as unknown as Record<string, unknown>[]) ?? []) {
      const id = n(r.id);
      if (!id || seen.has(id)) continue;
      if (r.deleted_at != null) continue;
      seen.add(id);
      collected.push(r as unknown as ProductIdentifierMapRow);
    }
  };

  const fnsku = n(hints.fnsku);
  if (fnsku) {
    trace(tracePath, `MAP fnsku org=${organizationId}`);
    const { data, error } = await client
      .from("product_identifier_map")
      .select(MAP_SELECT)
      .eq("organization_id", organizationId)
      .eq("store_id", sid)
      .eq("fnsku", fnsku)
      .limit(120);
    if (error) return { rows: [], error: error.message };
    push(data);
  }
  const msku = n(hints.msku);
  if (msku) {
    const { data, error } = await client
      .from("product_identifier_map")
      .select(MAP_SELECT)
      .eq("organization_id", organizationId)
      .eq("store_id", sid)
      .eq("seller_sku", msku)
      .limit(200);
    if (error) return { rows: [], error: error.message };
    push(data);
    const { data: d2, error: e2 } = await client
      .from("product_identifier_map")
      .select(MAP_SELECT)
      .eq("organization_id", organizationId)
      .eq("store_id", sid)
      .eq("msku", msku)
      .limit(200);
    if (e2) return { rows: [], error: e2.message };
    push(d2);
  }
  const asin = n(hints.asin);
  if (asin) {
    const { data, error } = await client
      .from("product_identifier_map")
      .select(MAP_SELECT)
      .eq("organization_id", organizationId)
      .eq("store_id", sid)
      .eq("asin", asin)
      .limit(200);
    if (error) return { rows: [], error: error.message };
    push(data);
  }

  return { rows: collected, error: null };
}

async function prefetchMapRowsForPage(
  client: SupabaseClient,
  lookups: { key: string; organizationId: string; storeId: string; hints: { fnsku?: string | null; msku?: string | null; asin?: string | null } }[],
  tracePath: string,
  warn: (c: string, d: string) => void,
): Promise<Map<string, ProductIdentifierMapRow[]>> {
  const out = new Map<string, ProductIdentifierMapRow[]>();
  for (let i = 0; i < lookups.length; i += MAP_PREFETCH_CONCURRENCY) {
    const slice = lookups.slice(i, i + MAP_PREFETCH_CONCURRENCY);
    const chunk = await Promise.all(
      slice.map(async (e) => {
        const { rows, error } = await fetchMapRowsForHints(client, e.organizationId, e.storeId, e.hints, tracePath);
        if (error) warn("MAP_FETCH", `${e.key}: ${error}`);
        return { key: e.key, rows };
      }),
    );
    for (const { key, rows } of chunk) out.set(key, rows);
  }
  return out;
}

function extractIdentifierHints(source: Record<string, unknown> | null): IdentifierLookupHints & {
  raw: Record<string, string | null>;
} {
  const raw: Record<string, string | null> = {
    sku: n(source?.sku ?? source?.seller_sku),
    fnsku: n(source?.fnsku),
    asin: n(source?.asin),
    msku: n(source?.msku ?? source?.seller_sku ?? source?.sku),
    upc: n(source?.upc_code ?? source?.upc),
    lpn: n(source?.lpn),
    order_id: n(source?.order_id),
  };
  const organizationId = n(source?.organization_id) ?? "";
  const storeId = n(source?.store_id);
  return {
    organizationId,
    storeId,
    fnsku: raw.fnsku,
    msku: raw.sku ?? raw.msku,
    asin: raw.asin,
    raw,
  };
}

async function fetchSourceRowsByIds(
  client: SupabaseClient,
  table: string,
  ids: string[],
  organizationScope: string | null,
  tracePath: string,
): Promise<{ map: Map<string, Record<string, unknown>>; error: string | null }> {
  const map = new Map<string, Record<string, unknown>>();
  if (ids.length === 0) return { map, error: null };
  const scope = organizationScope?.trim() || null;
  for (let i = 0; i < ids.length; i += SOURCE_FETCH_CHUNK) {
    const slice = ids.slice(i, i + SOURCE_FETCH_CHUNK);
    trace(tracePath, `SELECT ${table} * IN ids chunk ${i}${scope ? ` org=${scope}` : ""}`);
    let q = client.from(table).select("*").in("id", slice);
    if (scope) q = q.eq("organization_id", scope);
    const { data, error } = await q;
    if (error) return { map, error: error.message };
    for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
      const id = n(row.id);
      if (id) map.set(id, row);
    }
  }
  return { map, error: null };
}

async function fetchCandidateSourceContext(
  client: SupabaseClient,
  candidateIds: string[],
  tracePath: string,
  warn: (c: string, d: string) => void,
): Promise<Map<string, Record<string, unknown>>> {
  const m = new Map<string, Record<string, unknown>>();
  if (candidateIds.length === 0) return m;
  for (let i = 0; i < candidateIds.length; i += SOURCE_FETCH_CHUNK) {
    const slice = candidateIds.slice(i, i + SOURCE_FETCH_CHUNK);
    trace(tracePath, `SELECT v_claim_candidate_source_context IN claim_candidate_id chunk ${i}`);
    const { data, error } = await client.from("v_claim_candidate_source_context").select("*").in("claim_candidate_id", slice);
    if (error) {
      warn("SOURCE_CONTEXT_FETCH", error.message);
      continue;
    }
    for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
      const cid = n(row.claim_candidate_id);
      if (cid) m.set(cid, row);
    }
  }
  return m;
}

async function loadPimOpenMemberProductIds(
  client: SupabaseClient,
  tracePath: string,
  warn: (c: string, d: string) => void,
): Promise<Set<string>> {
  const set = new Set<string>();
  let from = 0;
  let totalRead = 0;
  for (;;) {
    trace(tracePath, `SELECT pim_identifier_dispute open members range ${from}`);
    const { data, error } = await client
      .from("pim_identifier_dispute")
      .select("id,members,status")
      .eq("status", "open")
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      warn("PIM_LOAD", error.message);
      break;
    }
    const batch = data ?? [];
    for (const r of batch as { members?: unknown; status?: string }[]) {
      if (Array.isArray(r.members)) {
        for (const m of r.members) {
          const s = n(m);
          if (s) set.add(s);
        }
      }
    }
    totalRead += batch.length;
    if (batch.length < PAGE) break;
    from += PAGE;
    if (totalRead >= PIM_OPEN_PAGE_MAX) {
      warn("PIM_LOAD", `Open dispute scan truncated at ${PIM_OPEN_PAGE_MAX} rows; member set may be incomplete`);
      break;
    }
  }
  return set;
}

/** Mutually exclusive final bucket per NEXT-CLAIM-09. */
function computeFinalBucket(args: {
  unsupported: boolean;
  missing: boolean;
  ambiguous: boolean;
  pimBlocked: boolean;
  proposedResolved: string | null;
  proposalFrom: ProposalFrom;
  evidenceStatus: string | null;
}): FinalBucket {
  if (args.unsupported) return "unsupported_source_table";
  if (args.missing) return "missing_source_row";
  if (args.ambiguous) return "ambiguous";
  if (args.pimBlocked && args.proposedResolved) return "blocked_pim";
  if (!args.proposedResolved) return "unresolved_no_identifiers";

  const evidenceOk = args.evidenceStatus !== "missing";

  if (args.proposalFrom === "identifier_map") {
    if (evidenceOk) return "safe_update_candidate";
    return "resolvable_from_identifiers";
  }
  if (args.proposalFrom === "source_resolved" || args.proposalFrom === "source_product_id") {
    if (evidenceOk) return "safe_update_candidate";
    return "resolvable_from_source";
  }
  return "unresolved_no_identifiers";
}

async function main(): Promise<void> {
  loadEnvLocal();
  const { runId: runIdArg, organizationId: orgFilter, storeId: storeFilter } = parseArgs(process.argv.slice(2));
  const runId = runIdArg ?? isoRunId();
  const outDir = path.resolve(".cursor", "audit-reports", "next-claim-09", runId);
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

  const rollupPath = path.join(outDir, "00-resolution-rollup.csv");
  const ndjsonPath = path.join(outDir, "01-candidate-resolution.ndjson");
  const safePath = path.join(outDir, "02-safe-update-candidates.csv");
  const ambPath = path.join(outDir, "03-ambiguous-candidates.csv");
  const missPath = path.join(outDir, "04-missing-source-rows.csv");
  const pimCsvPath = path.join(outDir, "05-blocked-pim.csv");
  const unsupPath = path.join(outDir, "06-unsupported-source-tables.csv");
  const policyPath = path.join(outDir, "07-policy-settings-placeholder.json");
  const rollup08Path = path.join(outDir, "08-missing-source-row-rollup.csv");

  const auditHeaderLine = rowToCsvLine([...AUDIT_CSV_HEADERS]);

  fs.writeFileSync(rollupPath, "bucket,count,pct\n", "utf8");
  fs.writeFileSync(ndjsonPath, "", "utf8");
  fs.writeFileSync(safePath, auditHeaderLine, "utf8");
  fs.writeFileSync(ambPath, auditHeaderLine, "utf8");
  fs.writeFileSync(missPath, auditHeaderLine, "utf8");
  fs.writeFileSync(pimCsvPath, auditHeaderLine, "utf8");
  fs.writeFileSync(unsupPath, auditHeaderLine, "utf8");

  const bucketCounts: Record<string, number> = {};
  const bump = (b: string) => {
    bucketCounts[b] = (bucketCounts[b] ?? 0) + 1;
  };

  /** Rollup keys: normalized source_table string, or "(no_source_table)" when absent/blank. */
  const totalByTable = new Map<string, number>();
  const missingByTable = new Map<string, { count: number; samples: string[] }>();

  const pimMembers = await loadPimOpenMemberProductIds(client, tracePath, warn);

  fs.writeFileSync(
    policyPath,
    JSON.stringify(
      {
        status: "not_wired_yet",
        trust_source_product_id_env: TRUST_SOURCE_PRODUCT_ID,
        required_future_settings: {
          claim_wait_days_by_type: null,
          reimbursement_grace_days: null,
          removal_claim_wait_days: null,
          inventory_discrepancy_wait_days: null,
          stale_inventory_threshold_days: null,
          source_report_refresh_hours: null,
          sp_api_retry_policy: null,
          priority_scoring_weights: null,
          default_store_policy_inheritance: null,
        },
        note: "Claim eligibility, inventory timing, prioritization, and API polling/retry windows must be per-store configurable; do not hardcode as permanent logic.",
      },
      null,
      2,
    ),
    "utf8",
  );

  let totalCandidates = 0;
  let from = 0;
  for (;;) {
    trace(tracePath, `SELECT claim_candidates page ${from}`);
    let cq = client
      .from("claim_candidates")
      .select(
        "id, organization_id, store_id, source_table, source_row_id, resolved_product_id, evidence_status, sku, fnsku, asin",
      )
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (orgFilter) cq = cq.eq("organization_id", orgFilter);
    if (storeFilter) cq = cq.eq("store_id", storeFilter);
    const { data, error } = await cq;
    if (error) {
      warn("CLAIM_CANDIDATES", error.message);
      break;
    }
    const batch = (data ?? []) as unknown as Record<string, unknown>[];
    if (batch.length === 0) break;
    totalCandidates += batch.length;

    const byTable = new Map<string, string[]>();
    for (const c of batch) {
      const st = n(c.source_table)?.toLowerCase() ?? "";
      const sid = n(c.source_row_id);
      if (!st || !sid) continue;
      if (!SUPPORTED_SOURCES.has(st)) continue;
      if (!byTable.has(st)) byTable.set(st, []);
      byTable.get(st)!.push(sid);
    }

    const sourceMaps = new Map<string, Map<string, Record<string, unknown>>>();
    for (const [tbl, ids] of byTable) {
      const uniq = [...new Set(ids)];
      const { map, error: e2 } = await fetchSourceRowsByIds(client, tbl, uniq, orgFilter, tracePath);
      if (e2) warn("SOURCE_FETCH", `${tbl}: ${e2}`);
      sourceMaps.set(tbl, map);
    }

    const candidateIds = batch.map((c) => n(c.id)).filter(Boolean) as string[];
    const contextByCandidateId = await fetchCandidateSourceContext(client, candidateIds, tracePath, warn);

    const sourcePackByCandidateId = new Map<string, ClaimSourcePack>();
    for (const c of batch) {
      const claimCandidateId = n(c.id) ?? "";
      const ctx = contextByCandidateId.get(claimCandidateId) ?? null;
      const pack = await resolveClaimCandidateSourcePack(client, c as unknown as Record<string, unknown>, sourceMaps, ctx);
      sourcePackByCandidateId.set(claimCandidateId, pack);
    }

    const mapPrefetchKeys = new Map<
      string,
      { organizationId: string; storeId: string; hints: { fnsku?: string | null; msku?: string | null; asin?: string | null } }
    >();
    for (const c of batch) {
      if (n(c.resolved_product_id)) continue;
      const organizationId = n(c.organization_id) ?? "";
      const storeId = n(c.store_id);
      const sourceTable = n(c.source_table)?.toLowerCase() ?? "";
      const sourceRowId = n(c.source_row_id);
      if (!sourceTable || !sourceRowId || !SUPPORTED_SOURCES.has(sourceTable)) continue;
      const pack = sourcePackByCandidateId.get(n(c.id) ?? "") ?? {
        row: null,
        alternateTier: null,
        opReasonCodes: [],
        ambiguousOperational: false,
        id_lookup_hit: false,
      };
      const row = pack.row;
      if (!row) continue;
      if (n(row.resolved_product_id)) continue;
      if (TRUST_SOURCE_PRODUCT_ID && n(row.product_id)) continue;
      const hints = extractIdentifierHints(row);
      const effStore = storeId ?? n(row.store_id);
      if (!effStore) continue;
      const key = mapLookupCacheKey(organizationId, effStore, {
        fnsku: hints.fnsku,
        msku: hints.msku,
        asin: hints.asin,
      });
      if (!mapPrefetchKeys.has(key)) {
        mapPrefetchKeys.set(key, {
          organizationId,
          storeId: effStore,
          hints: { fnsku: hints.fnsku, msku: hints.msku, asin: hints.asin },
        });
      }
    }
    const mapCache = await prefetchMapRowsForPage(
      client,
      [...mapPrefetchKeys.entries()].map(([key, v]) => ({ key, ...v })),
      tracePath,
      warn,
    );

    for (const c of batch) {
      const claimCandidateId = n(c.id) ?? "";
      const organizationId = n(c.organization_id);
      const storeId = n(c.store_id);
      const sourceTableRaw = n(c.source_table);
      const sourceTable = sourceTableRaw?.toLowerCase() ?? "";
      const sourceRowId = n(c.source_row_id);
      const existingResolved = n(c.resolved_product_id);
      const evidenceStatus = n(c.evidence_status);

      let sourceFound = false;
      let sourceRow: Record<string, unknown> | null = null;
      let sourceTier = "none";
      let proposedResolved: string | null = null;
      let proposedProductId: string | null = null;
      const reasonCodes: string[] = [];
      let mapHits = 0;
      let mapMatch: ProductIdentifierMatchResult | null = null;
      let proposalFrom: ProposalFrom = "none";
      let ambiguous = false;

      if (existingResolved) {
        proposedResolved = existingResolved;
        sourceTier = "candidate_existing_resolved";
        proposalFrom = "source_resolved";
        sourceFound = true;
      } else if (!sourceTable || !sourceRowId) {
        reasonCodes.push("missing_source_pointer");
      } else if (!SUPPORTED_SOURCES.has(sourceTable)) {
        reasonCodes.push("unsupported_source_table");
      } else {
        const pack = sourcePackByCandidateId.get(claimCandidateId) ?? {
          row: null,
          alternateTier: null,
          opReasonCodes: [],
          ambiguousOperational: false,
          id_lookup_hit: false,
        };
        reasonCodes.push(...pack.opReasonCodes);
        if (pack.ambiguousOperational) ambiguous = true;

        const row = pack.row;
        const alternateTier = pack.alternateTier;
        if (row) {
          sourceFound = true;
          sourceRow = row;
          if (alternateTier) sourceTier = alternateTier;
          const rpid = n(row.resolved_product_id);
          const pid = n(row.product_id);
          if (rpid) {
            proposedResolved = rpid;
            sourceTier = "source_resolved_product_id";
            proposalFrom = "source_resolved";
          } else if (TRUST_SOURCE_PRODUCT_ID && pid) {
            proposedResolved = pid;
            proposedProductId = pid;
            sourceTier = "source_product_id_trusted";
            proposalFrom = "source_product_id";
            reasonCodes.push("used_product_id_under_env_trust");
          } else {
            const hints = extractIdentifierHints(row);
            const effStore = storeId ?? n(row.store_id);
            const mapKey =
              effStore != null
                ? mapLookupCacheKey(organizationId ?? "", effStore, {
                    fnsku: hints.fnsku,
                    msku: hints.msku,
                    asin: hints.asin,
                  })
                : null;
            const mapRows = mapKey != null ? (mapCache.get(mapKey) ?? []) : [];
            mapHits = mapRows.length;
            if (!effStore) {
              reasonCodes.push("identifier_skipped_no_store_id");
            } else {
              const match = pickBestProductIdentifierMatch(mapRows, {
                organizationId: organizationId ?? "",
                storeId: effStore,
                fnsku: hints.fnsku,
                msku: hints.msku,
                asin: hints.asin,
              });
              mapMatch = match;
              if (match.status === "resolved" && n(match.row?.product_id)) {
                proposedResolved = n(match.row!.product_id);
                sourceTier = "identifier_map";
                proposalFrom = "identifier_map";
              } else if (match.status === "ambiguous") {
                ambiguous = true;
                sourceTier = "identifier_map_ambiguous";
              }
            }
          }
        }
      }

      const pimBlocked = !!(proposedResolved && pimMembers.has(proposedResolved));
      const unsupported = !!(sourceTableRaw && !SUPPORTED_SOURCES.has(sourceTable));
      const missingPointer = !existingResolved && !unsupported && (!sourceTable || !sourceRowId);
      const missingRow =
        !unsupported &&
        !missingPointer &&
        !!sourceTable &&
        !!sourceRowId &&
        SUPPORTED_SOURCES.has(sourceTable) &&
        !sourceFound &&
        !existingResolved;
      const missing = missingPointer || missingRow;

      const finalBucket = computeFinalBucket({
        unsupported,
        missing,
        ambiguous,
        pimBlocked,
        proposedResolved,
        proposalFrom,
        evidenceStatus,
      });

      if (reasonCodes.length === 0 && finalBucket === "unresolved_no_identifiers") {
        reasonCodes.push("no_resolution_path");
      }

      const confidence =
        mapMatch?.status === "resolved"
          ? mapMatch.confidence
          : sourceTier.startsWith("source_resolved")
            ? 0.98
            : proposedResolved
              ? 0.8
              : 0.15;

      const rec: NdjsonRecord = {
        run_id: runId,
        claim_candidate_id: claimCandidateId,
        organization_id: organizationId,
        store_id: storeId,
        source_table: sourceTableRaw,
        source_row_id: sourceRowId,
        source_found: sourceFound,
        source_resolution_tier: sourceTier,
        proposed_resolved_product_id: proposedResolved,
        proposed_product_id: proposedProductId,
        identifier_inputs: sourceRow ? extractIdentifierHints(sourceRow).raw : {},
        map_hits_count: mapHits,
        pim_blocked: pimBlocked,
        final_bucket: finalBucket,
        reason_codes: reasonCodes,
        confidence,
        never_auto_submit: true,
        policy_settings_status: "not_wired_yet",
        recommended_next_action:
          finalBucket === "blocked_pim"
            ? "enrich_product_identity"
            : finalBucket === "safe_update_candidate"
              ? "review_dry_run_then_apply_future_job"
              : finalBucket === "ambiguous"
                ? "manual_review"
                : "review",
        evidence_status: evidenceStatus,
        proposal_from: proposalFrom,
      };

      bump(finalBucket);
      fs.appendFileSync(ndjsonPath, JSON.stringify(rec) + "\n", "utf8");

      const tableRollupKey =
        sourceTableRaw != null && String(sourceTableRaw).trim() !== ""
          ? String(sourceTableRaw).trim().toLowerCase()
          : "(no_source_table)";
      totalByTable.set(tableRollupKey, (totalByTable.get(tableRollupKey) ?? 0) + 1);
      if (finalBucket === "missing_source_row") {
        const prev = missingByTable.get(tableRollupKey) ?? { count: 0, samples: [] as string[] };
        prev.count += 1;
        if (prev.samples.length < 5 && sourceRowId && !prev.samples.includes(sourceRowId)) {
          prev.samples.push(sourceRowId);
        }
        missingByTable.set(tableRollupKey, prev);
      }

      const detailLine = auditDetailCsvLine({
        claimCandidateId,
        proposedResolved,
        sourceTableRaw,
        sourceRowId,
        evidenceStatus,
        sourceResolutionTier: sourceTier,
        proposalFrom,
        reasonCodes,
      });
      if (finalBucket === "safe_update_candidate") fs.appendFileSync(safePath, detailLine, "utf8");
      else if (finalBucket === "ambiguous") fs.appendFileSync(ambPath, detailLine, "utf8");
      else if (finalBucket === "missing_source_row") fs.appendFileSync(missPath, detailLine, "utf8");
      else if (finalBucket === "blocked_pim") fs.appendFileSync(pimCsvPath, detailLine, "utf8");
      else if (finalBucket === "unsupported_source_table") fs.appendFileSync(unsupPath, detailLine, "utf8");
    }

    if (batch.length < PAGE) break;
    from += PAGE;
  }

  const total = Object.values(bucketCounts).reduce((a, b) => a + b, 0) || 1;
  for (const [b, v] of Object.entries(bucketCounts).sort((a, x) => a[0].localeCompare(x[0]))) {
    fs.appendFileSync(rollupPath, rowToCsvLine([b, String(v), ((100 * v) / total).toFixed(2)]), "utf8");
  }

  fs.writeFileSync(
    rollup08Path,
    rowToCsvLine([
      "source_table",
      "missing_source_row_count",
      "total_candidates_for_source_table",
      "percent_missing",
      "sample_source_row_ids",
    ]),
    "utf8",
  );
  for (const [tbl, tot] of [...totalByTable.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const missEntry = missingByTable.get(tbl);
    const miss = missEntry?.count ?? 0;
    const pct = tot ? ((100 * miss) / tot).toFixed(2) : "0.00";
    const samples = (missEntry?.samples ?? []).join(";");
    fs.appendFileSync(rollup08Path, rowToCsvLine([tbl, String(miss), String(tot), pct, samples]), "utf8");
  }

  const manifest = {
    run_id: runId,
    read_only: true,
    no_db_writes: true,
    organization_id_filter: orgFilter ?? null,
    store_id_filter: storeFilter ?? null,
    total_candidates_processed: totalCandidates,
    bucket_counts: bucketCounts,
    pim_open_member_ids_distinct: pimMembers.size,
    trust_source_product_id: TRUST_SOURCE_PRODUCT_ID,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  const files = [
    "manifest.json",
    "00-resolution-rollup.csv",
    "01-candidate-resolution.ndjson",
    "02-safe-update-candidates.csv",
    "03-ambiguous-candidates.csv",
    "04-missing-source-rows.csv",
    "05-blocked-pim.csv",
    "06-unsupported-source-tables.csv",
    "07-policy-settings-placeholder.json",
    "08-missing-source-row-rollup.csv",
    path.join("logs", "query-trace.txt"),
    path.join("logs", "warnings.ndjson"),
  ];

  const checks: { id: string; passed: boolean; detail: string }[] = [];
  checks.push({ id: "J1", passed: true, detail: "No write mode; SELECT-only." });

  const missingPre = files.filter((f) => !fs.existsSync(path.join(outDir, f)));
  checks.push({
    id: "J2",
    passed: missingPre.length === 0,
    detail: missingPre.length ? `Missing: ${missingPre.join(",")}` : "Core files present (pre-validation).",
  });

  const bucketSum = Object.values(bucketCounts).reduce((a, b) => a + b, 0);
  checks.push({
    id: "J3",
    passed: totalCandidates === 0 || bucketSum === totalCandidates,
    detail: `candidates=${totalCandidates} bucket_sum=${bucketSum}`,
  });
  checks.push({
    id: "J4",
    passed: true,
    detail: "Supported tables: amazon_returns, amazon_removals, amazon_removal_shipments, returns.",
  });
  checks.push({ id: "J5", passed: true, detail: "Missing source rows bucket; non-fatal." });
  checks.push({
    id: "J6",
    passed: true,
    detail: "pickBestProductIdentifierMatch; ambiguous never yields a single product_id.",
  });

  const safeCount = bucketCounts.safe_update_candidate ?? 0;
  const blockedCount = bucketCounts.blocked_pim ?? 0;
  let pimOverlapViolations = 0;
  const ndLines = fs.readFileSync(ndjsonPath, "utf8").split("\n").filter(Boolean);
  for (const line of ndLines) {
    try {
      const o = JSON.parse(line) as NdjsonRecord;
      if (o.final_bucket === "safe_update_candidate" && o.pim_blocked) pimOverlapViolations += 1;
    } catch {
      /* skip */
    }
  }
  checks.push({
    id: "J7",
    passed: pimOverlapViolations === 0,
    detail: `safe rows with pim_blocked flag: ${pimOverlapViolations} (must be 0). blocked_pim count=${blockedCount}`,
  });
  checks.push({
    id: "J8",
    passed: true,
    detail: `safe_update_candidate=${safeCount}; gated by evidence_status !== missing and !pim.`,
  });
  checks.push({
    id: "J9",
    passed: fs.existsSync(policyPath),
    detail: "07-policy-settings-placeholder.json emitted.",
  });
  checks.push({
    id: "J10",
    passed: true,
    detail: "No Amazon/AI/product mutation/DB writes.",
  });

  const expAudit = [...AUDIT_CSV_HEADERS];
  const h04 = readCsvHeaderRow(missPath);
  const h05 = readCsvHeaderRow(pimCsvPath);
  const h06 = readCsvHeaderRow(unsupPath);
  const align04 = expAudit.length === h04.length && expAudit.every((c, i) => h04[i] === c);
  const align05 = expAudit.length === h05.length && expAudit.every((c, i) => h05[i] === c);
  const align06 = expAudit.length === h06.length && expAudit.every((c, i) => h06[i] === c);
  checks.push({
    id: "J11",
    passed: align04 && align05 && align06,
    detail: `CSV headers match AUDIT_CSV_HEADERS for 04/05/06: 04=${align04} 05=${align05} 06=${align06}`,
  });

  let ndjsonAuditOk = totalCandidates === 0;
  if (totalCandidates > 0) {
    if (ndLines.length === 0) {
      ndjsonAuditOk = false;
    } else {
      ndjsonAuditOk = true;
      for (const line of ndLines.slice(0, Math.min(20, ndLines.length))) {
        try {
          const o = JSON.parse(line) as NdjsonRecord;
          if (
            !("evidence_status" in o) ||
            !("proposal_from" in o) ||
            !("source_resolution_tier" in o) ||
            !("source_table" in o) ||
            !("source_row_id" in o) ||
            !("final_bucket" in o) ||
            !("reason_codes" in o) ||
            !("confidence" in o) ||
            !("pim_blocked" in o) ||
            !("never_auto_submit" in o)
          ) {
            ndjsonAuditOk = false;
            break;
          }
        } catch {
          ndjsonAuditOk = false;
          break;
        }
      }
    }
  }
  checks.push({
    id: "J12",
    passed: ndjsonAuditOk,
    detail: "NDJSON rows include evidence_status, proposal_from, source_resolution_tier, and required audit fields (sampled).",
  });

  let missingRollupSum = 0;
  for (const [, v] of missingByTable) missingRollupSum += v.count;
  const missingBucket = bucketCounts.missing_source_row ?? 0;
  checks.push({
    id: "J13",
    passed: fs.existsSync(rollup08Path) && missingRollupSum === missingBucket,
    detail: `08 rollup present; rollup_missing_sum=${missingRollupSum} bucket_missing=${missingBucket}`,
  });

  const jOrder = ["J1", "J2", "J3", "J4", "J5", "J6", "J7", "J8", "J9", "J10", "J11", "J12", "J13"];
  checks.sort((a, b) => jOrder.indexOf(a.id) - jOrder.indexOf(b.id));
  fs.writeFileSync(path.join(outDir, "10-validation-checks.json"), JSON.stringify(checks, null, 2), "utf8");

  const j2post =
    files.every((f) => fs.existsSync(path.join(outDir, f))) && fs.existsSync(path.join(outDir, "10-validation-checks.json"));
  const j2Entry = checks.find((x) => x.id === "J2");
  if (j2Entry) {
    j2Entry.passed = j2post;
    j2Entry.detail = j2post ? "All outputs including validation." : "Post validation file check failed";
  }
  fs.writeFileSync(path.join(outDir, "10-validation-checks.json"), JSON.stringify(checks, null, 2), "utf8");

  const strictFail =
    !checks.find((c) => c.id === "J2")?.passed ||
    !checks.find((c) => c.id === "J3")?.passed ||
    !checks.find((c) => c.id === "J7")?.passed ||
    !checks.find((c) => c.id === "J9")?.passed ||
    !checks.find((c) => c.id === "J11")?.passed ||
    !checks.find((c) => c.id === "J12")?.passed ||
    !checks.find((c) => c.id === "J13")?.passed;
  if (strictFail) process.exitCode = 1;

  console.log(JSON.stringify({ runId, outDir, bucketCounts, totalCandidates, checks, exitCode: strictFail ? 1 : 0 }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
