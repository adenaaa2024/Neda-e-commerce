/**
 * NEXT-CLAIM-17 — Read-only amazon_removals stale lineage repair classifier.
 *
 *   npx tsx scripts/claim17-amazon-removals-repair-classifier.ts --org-id=<uuid>
 *   npx tsx scripts/claim17-amazon-removals-repair-classifier.ts --org-id=<uuid> --run-id=myRun
 *
 * Writes local artifacts only:
 *   .cursor/audit-reports/next-claim-17/<run_id>/
 *
 * SELECT-only. No repairs. No DB writes. No source_row_id updates.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { mergeOperationalHints } from "../lib/claim-operational-source-resolve";
import { coerceRemovalOrderBusinessKeyColumns } from "../lib/pipeline/amazon-removals-business-key";
import { isUuidString } from "../lib/uuid";

const PAGE = 500;
const IN_CHUNK = 150;
const SAMPLE_LIMIT = 200;
const CLASSIFIER_VERSION = "claim17-readonly-v1";

const REQUIRED_OUTPUTS = [
  "00-classifier-summary.json",
  "01-repairability-by-tier.csv",
  "02-deterministic-repair-candidates.csv",
  "03-ambiguous-repair-candidates.csv",
  "04-unrecoverable-candidates.csv",
  "05-manual-review-sample.csv",
  "logs/claim17-repair-classifier.ndjson",
  "validation-results.md",
  "next-step-recommendation.md",
  "manifest.json",
] as const;

type Tier = 0 | 1 | 2 | 3 | 4 | 5 | 6;

type RepairabilityStatus =
  | "already_current"
  | "repairable_unique"
  | "reviewable_unique_context"
  | "ambiguous_manual_review"
  | "unrecoverable_no_live_evidence"
  | "classifier_error";

type CandidateRow = {
  id: string;
  organization_id: string;
  store_id: string | null;
  source_table: string;
  source_row_id: string;
  upload_id: string | null;
  source_staging_id: string | null;
  order_id: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  disposition: string | null;
  requested_quantity: unknown;
  shipped_quantity: unknown;
  disposed_quantity: unknown;
  cancelled_quantity: unknown;
  order_date: unknown;
  order_type: string | null;
};

type RemovalRow = {
  id: string;
  organization_id: string;
  store_id?: string | null;
  upload_id?: string | null;
  source_staging_id?: string | null;
  order_id?: string | null;
  sku?: string | null;
  fnsku?: string | null;
  asin?: string | null;
  disposition?: string | null;
  requested_quantity?: unknown;
  shipped_quantity?: unknown;
  disposed_quantity?: unknown;
  cancelled_quantity?: unknown;
  order_date?: unknown;
  order_type?: string | null;
};

type ExpectedPackageRow = {
  id: string;
  organization_id?: string | null;
  store_id?: string | null;
  upload_id?: string | null;
  source_staging_id?: string | null;
  source_detail_row_id?: string | null;
  order_id?: string | null;
  sku?: string | null;
  fnsku?: string | null;
};

type CandidateCounts = {
  exact_id: number;
  upload_staging: number;
  expected_package_bridge: number;
  business_key: number;
  context_identifier: number;
};

type ClassificationRow = {
  claim_candidate_id: string;
  artifact_table: "claim_candidates";
  organization_id: string;
  store_id: string | null;
  source_table: string;
  old_source_row_id: string;
  proposed_current_source_row_id: string | null;
  proposed_source_upload_id: string | null;
  upload_id: string | null;
  proposed_source_staging_id: string | null;
  evidence_tier: Tier;
  confidence: number;
  ambiguity_count: number;
  repairability_status: RepairabilityStatus;
  reason_code: string;
  evidence_json: Record<string, unknown>;
  requires_human_review: boolean;
  do_not_apply_reason: string | null;
};

type Args = {
  orgId: string | null;
  runId: string | null;
};

function loadEnvLocal(): void {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

function createServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  return createClient(url, key, { auth: { persistSession: false } });
}

function n(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function isoRunId(): string {
  const d = new Date();
  const pad = (x: number) => String(x).padStart(2, "0");
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

function parseArgs(argv: string[]): Args {
  let orgId: string | null = null;
  let runId: string | null = null;
  for (const a of argv) {
    if (a.startsWith("--org-id=")) orgId = a.slice("--org-id=".length).trim() || null;
    if (a.startsWith("--organization-id=")) orgId = a.slice("--organization-id=".length).trim() || null;
    if (a.startsWith("--run-id=")) runId = a.slice("--run-id=".length).trim() || null;
  }
  return { orgId, runId };
}

function escapeCsvCell(v: string): string {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function rowToCsvLine(cols: string[]): string {
  return cols.map((c) => escapeCsvCell(c)).join(",") + "\n";
}

function traceNd(logPath: string, rec: Record<string, unknown>): void {
  fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n", "utf8");
}

function jsonCell(v: unknown): string {
  return JSON.stringify(v ?? null);
}

function boolCell(v: boolean): string {
  return v ? "true" : "false";
}

function numCell(v: number): string {
  return v.toFixed(2);
}

function firstRows(rows: RemovalRow[], limit = 8): Record<string, unknown>[] {
  return rows.slice(0, limit).map((r) => ({
    id: n(r.id),
    upload_id: n(r.upload_id),
    source_staging_id: n(r.source_staging_id),
    store_id: n(r.store_id),
    order_id: n(r.order_id),
    sku: n(r.sku),
    fnsku: n(r.fnsku),
    asin: n(r.asin),
    order_date: n(r.order_date),
    order_type: n(r.order_type),
  }));
}

async function columnAvailable(
  client: SupabaseClient,
  table: string,
  column: string,
  orgId: string,
  tracePath: string,
): Promise<boolean> {
  const { error } = await client.from(table).select(`id, ${column}`).eq("organization_id", orgId).limit(1);
  traceNd(tracePath, { phase: "column_probe", table, column, available: !error, error: error?.message });
  return !error;
}

async function buildClaimCandidatesSelect(client: SupabaseClient, orgId: string, tracePath: string): Promise<string> {
  const base = ["id", "organization_id", "store_id", "source_table", "source_row_id", "sku", "fnsku", "asin"];
  const optional = [
    "upload_id",
    "source_staging_id",
    "order_id",
    "disposition",
    "requested_quantity",
    "shipped_quantity",
    "disposed_quantity",
    "cancelled_quantity",
    "order_date",
    "order_type",
  ];
  const cols = [...base];
  for (const col of optional) {
    if (await columnAvailable(client, "claim_candidates", col, orgId, tracePath)) cols.push(col);
  }
  const select = cols.join(", ");
  traceNd(tracePath, { phase: "claim_candidates_select", columns: select });
  return select;
}

async function buildRemovalSelect(client: SupabaseClient, orgId: string, tracePath: string): Promise<string> {
  const base = [
    "id",
    "organization_id",
    "store_id",
    "upload_id",
    "source_staging_id",
    "order_id",
    "sku",
    "fnsku",
    "disposition",
    "requested_quantity",
    "shipped_quantity",
    "disposed_quantity",
    "cancelled_quantity",
    "order_date",
    "order_type",
  ];
  if (await columnAvailable(client, "amazon_removals", "asin", orgId, tracePath)) base.push("asin");
  const select = base.join(", ");
  traceNd(tracePath, { phase: "amazon_removals_select", columns: select });
  return select;
}

function toCandidateRow(row: Record<string, unknown>, orgId: string): CandidateRow | null {
  const id = n(row.id);
  const sourceRowId = n(row.source_row_id);
  if (!id || !sourceRowId) return null;
  return {
    id,
    organization_id: n(row.organization_id) ?? orgId,
    store_id: n(row.store_id),
    source_table: n(row.source_table) ?? "amazon_removals",
    source_row_id: sourceRowId,
    upload_id: n(row.upload_id),
    source_staging_id: n(row.source_staging_id),
    order_id: n(row.order_id),
    sku: n(row.sku),
    fnsku: n(row.fnsku),
    asin: n(row.asin),
    disposition: n(row.disposition),
    requested_quantity: row.requested_quantity ?? null,
    shipped_quantity: row.shipped_quantity ?? null,
    disposed_quantity: row.disposed_quantity ?? null,
    cancelled_quantity: row.cancelled_quantity ?? null,
    order_date: row.order_date ?? null,
    order_type: n(row.order_type),
  };
}

async function fetchCandidateSourceContext(
  client: SupabaseClient,
  candidateIds: string[],
  tracePath: string,
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < candidateIds.length; i += IN_CHUNK) {
    const slice = candidateIds.slice(i, i + IN_CHUNK);
    const { data, error } = await client.from("v_claim_candidate_source_context").select("*").in("claim_candidate_id", slice);
    traceNd(tracePath, { phase: "fetch_source_context", chunk: i, count: slice.length, error: error?.message });
    if (error) continue;
    for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
      const id = n(row.claim_candidate_id);
      if (id) out.set(id, row);
    }
  }
  return out;
}

async function fetchRemovalRowsByIds(
  client: SupabaseClient,
  ids: string[],
  orgId: string,
  removalSelect: string,
  tracePath: string,
): Promise<Map<string, RemovalRow>> {
  const out = new Map<string, RemovalRow>();
  const uniq = [...new Set(ids.filter((x) => isUuidString(x)))];
  for (let i = 0; i < uniq.length; i += IN_CHUNK) {
    const slice = uniq.slice(i, i + IN_CHUNK);
    const { data, error } = await client
      .from("amazon_removals")
      .select(removalSelect)
      .eq("organization_id", orgId)
      .in("id", slice);
    traceNd(tracePath, { phase: "fetch_removal_by_id", chunk: i, count: slice.length, error: error?.message });
    if (error) continue;
    for (const row of (data ?? []) as unknown as RemovalRow[]) {
      const id = n(row.id);
      if (id) out.set(id, row);
    }
  }
  return out;
}

async function fetchExpectedPackagesByColumn(
  client: SupabaseClient,
  ids: string[],
  orgId: string,
  col: "id" | "source_detail_row_id",
  tracePath: string,
): Promise<Map<string, ExpectedPackageRow[]>> {
  const out = new Map<string, ExpectedPackageRow[]>();
  const uniq = [...new Set(ids.filter((x) => isUuidString(x)))];
  const select = "id, organization_id, store_id, upload_id, source_staging_id, source_detail_row_id, order_id, sku, fnsku";
  for (let i = 0; i < uniq.length; i += IN_CHUNK) {
    const slice = uniq.slice(i, i + IN_CHUNK);
    const { data, error } = await client.from("expected_packages").select(select).eq("organization_id", orgId).in(col, slice);
    traceNd(tracePath, { phase: "fetch_expected_packages", col, chunk: i, count: slice.length, error: error?.message });
    if (error) continue;
    for (const row of (data ?? []) as ExpectedPackageRow[]) {
      const key = n(row[col]);
      if (!key) continue;
      const rows = out.get(key) ?? [];
      rows.push(row);
      out.set(key, rows);
    }
  }
  return out;
}

function candidateCounts(): CandidateCounts {
  return {
    exact_id: 0,
    upload_staging: 0,
    expected_package_bridge: 0,
    business_key: 0,
    context_identifier: 0,
  };
}

function evidence(
  tier: Tier,
  matchedVia: string,
  candidate: CandidateRow,
  counts: CandidateCounts,
  reasonCodes: string[],
  matchedRow: RemovalRow | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    tier,
    matched_via: matchedVia,
    old_source_row_id: candidate.source_row_id,
    candidate_counts: counts,
    matched_row: matchedRow
      ? {
          id: n(matchedRow.id),
          upload_id: n(matchedRow.upload_id),
          source_staging_id: n(matchedRow.source_staging_id),
          store_id: n(matchedRow.store_id),
          order_id: n(matchedRow.order_id),
          sku: n(matchedRow.sku),
          fnsku: n(matchedRow.fnsku),
          asin: n(matchedRow.asin),
          order_date: n(matchedRow.order_date),
          order_type: n(matchedRow.order_type),
        }
      : null,
    input_fields_present: Object.entries({
      organization_id: candidate.organization_id,
      store_id: candidate.store_id,
      upload_id: candidate.upload_id,
      source_staging_id: candidate.source_staging_id,
      order_id: candidate.order_id,
      sku: candidate.sku,
      fnsku: candidate.fnsku,
      asin: candidate.asin,
      disposition: candidate.disposition,
      order_date: candidate.order_date,
      order_type: candidate.order_type,
    })
      .filter(([, v]) => n(v) != null)
      .map(([k]) => k),
    reason_codes: reasonCodes,
    classifier_version: CLASSIFIER_VERSION,
    ...extra,
  };
}

function resultRow(args: {
  candidate: CandidateRow;
  tier: Tier;
  confidence: number;
  ambiguityCount: number;
  status: RepairabilityStatus;
  reasonCode: string;
  reasonCodes: string[];
  matchedVia: string;
  matchedRow: RemovalRow | null;
  counts: CandidateCounts;
  requiresHumanReview: boolean;
  doNotApplyReason: string | null;
  extraEvidence?: Record<string, unknown>;
}): ClassificationRow {
  const r = args.matchedRow;
  return {
    claim_candidate_id: args.candidate.id,
    artifact_table: "claim_candidates",
    organization_id: args.candidate.organization_id,
    store_id: args.candidate.store_id,
    source_table: args.candidate.source_table,
    old_source_row_id: args.candidate.source_row_id,
    proposed_current_source_row_id: args.tier === 0 ? null : (n(r?.id) ?? null),
    proposed_source_upload_id: args.tier === 0 ? null : (n(r?.upload_id) ?? null),
    upload_id: args.candidate.upload_id,
    proposed_source_staging_id: args.tier === 0 ? null : (n(r?.source_staging_id) ?? null),
    evidence_tier: args.tier,
    confidence: args.confidence,
    ambiguity_count: args.ambiguityCount,
    repairability_status: args.status,
    reason_code: args.reasonCode,
    evidence_json: evidence(
      args.tier,
      args.matchedVia,
      args.candidate,
      args.counts,
      args.reasonCodes,
      args.matchedRow,
      args.extraEvidence,
    ),
    requires_human_review: args.requiresHumanReview,
    do_not_apply_reason: args.doNotApplyReason,
  };
}

async function lookupUploadStaging(
  client: SupabaseClient,
  candidate: CandidateRow,
  removalSelect: string,
  tracePath: string,
): Promise<RemovalRow[]> {
  if (!candidate.upload_id || !candidate.source_staging_id) return [];
  const { data, error } = await client
    .from("amazon_removals")
    .select(removalSelect)
    .eq("organization_id", candidate.organization_id)
    .eq("upload_id", candidate.upload_id)
    .eq("source_staging_id", candidate.source_staging_id)
    .limit(8);
  traceNd(tracePath, {
    phase: "tier1_upload_staging",
    claim_candidate_id: candidate.id,
    error: error?.message,
    rows: data?.length ?? 0,
  });
  if (error) return [];
  return (data ?? []) as unknown as RemovalRow[];
}

function pickContextualValue(candidate: CandidateRow, context: Record<string, unknown> | null, keys: string[]): string | null {
  for (const key of keys) {
    const v = n((candidate as unknown as Record<string, unknown>)[key]);
    if (v) return v;
  }
  const ctx = context ?? {};
  for (const key of keys) {
    const v = n(ctx[key]);
    if (v) return v;
  }
  return null;
}

function businessKeyInput(
  candidate: CandidateRow,
  context: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const hints = mergeOperationalHints(candidate as unknown as Record<string, unknown>, context);
  const row = {
    organization_id: candidate.organization_id,
    store_id: candidate.store_id,
    order_id: hints.order_id,
    sku: hints.sku,
    fnsku: hints.fnsku,
    disposition: pickContextualValue(candidate, context, ["disposition", "source_disposition"]),
    requested_quantity: candidate.requested_quantity ?? context?.requested_quantity ?? context?.source_requested_quantity ?? null,
    shipped_quantity: candidate.shipped_quantity ?? context?.shipped_quantity ?? context?.source_shipped_quantity ?? null,
    disposed_quantity: candidate.disposed_quantity ?? context?.disposed_quantity ?? context?.source_disposed_quantity ?? null,
    cancelled_quantity: candidate.cancelled_quantity ?? context?.cancelled_quantity ?? context?.source_cancelled_quantity ?? null,
    order_date: candidate.order_date ?? context?.order_date ?? context?.source_order_date ?? null,
    order_type: pickContextualValue(candidate, context, ["order_type", "source_order_type"]),
  };

  const hasOrder = !!n(row.order_id);
  const hasItem = !!(n(row.sku) || n(row.fnsku));
  const disambiguators = [
    row.disposition,
    row.requested_quantity,
    row.shipped_quantity,
    row.disposed_quantity,
    row.cancelled_quantity,
    row.order_date,
    row.order_type,
  ].filter((x) => n(x) != null).length;

  if (!hasOrder || !hasItem || disambiguators < 2) return null;
  return row;
}

function applyNullSafeEq<T>(
  q: T,
  col: string,
  value: string | number | null,
): T {
  const builder = q as unknown as { eq: (c: string, v: string | number) => T; is: (c: string, v: null) => T };
  if (value == null) return builder.is(col, null);
  return builder.eq(col, value);
}

async function lookupBusinessKey(
  client: SupabaseClient,
  candidate: CandidateRow,
  context: Record<string, unknown> | null,
  removalSelect: string,
  tracePath: string,
): Promise<{ rows: RemovalRow[]; key: Record<string, unknown> | null }> {
  const input = businessKeyInput(candidate, context);
  if (!input) return { rows: [], key: null };
  const c = coerceRemovalOrderBusinessKeyColumns(input);
  let q = client.from("amazon_removals").select(removalSelect).eq("organization_id", c.organization_id).limit(8);
  q = applyNullSafeEq(q, "store_id", c.store_id);
  q = applyNullSafeEq(q, "order_id", c.order_id);
  q = applyNullSafeEq(q, "sku", c.sku);
  q = applyNullSafeEq(q, "fnsku", c.fnsku);
  q = applyNullSafeEq(q, "disposition", c.disposition);
  q = applyNullSafeEq(q, "requested_quantity", c.requested_quantity);
  q = applyNullSafeEq(q, "shipped_quantity", c.shipped_quantity);
  q = applyNullSafeEq(q, "disposed_quantity", c.disposed_quantity);
  q = applyNullSafeEq(q, "cancelled_quantity", c.cancelled_quantity);
  q = applyNullSafeEq(q, "order_date", c.order_date);
  q = applyNullSafeEq(q, "order_type", c.order_type);
  const { data, error } = await q;
  traceNd(tracePath, {
    phase: "tier3_business_key",
    claim_candidate_id: candidate.id,
    key: c,
    error: error?.message,
    rows: data?.length ?? 0,
  });
  if (error) return { rows: [], key: c };
  return { rows: (data ?? []) as unknown as RemovalRow[], key: c };
}

async function lookupContextIdentifier(
  client: SupabaseClient,
  candidate: CandidateRow,
  context: Record<string, unknown> | null,
  removalSelect: string,
  removalHasAsin: boolean,
  tracePath: string,
): Promise<{ rows: RemovalRow[]; matchedVia: string; confidence: number }> {
  const hints = mergeOperationalHints(candidate as unknown as Record<string, unknown>, context);
  const orderId = hints.order_id;
  if (!orderId) return { rows: [], matchedVia: "none", confidence: 0 };

  const keys: { col: "sku" | "fnsku" | "asin"; val: string | null; confidence: number }[] = [
    { col: "sku", val: hints.sku, confidence: candidate.store_id ? 0.8 : 0.75 },
    { col: "fnsku", val: hints.fnsku, confidence: candidate.store_id ? 0.8 : 0.75 },
  ];
  if (removalHasAsin) keys.push({ col: "asin", val: hints.asin, confidence: 0.7 });

  for (const key of keys) {
    if (!key.val) continue;
    if (candidate.store_id) {
      const { data, error } = await client
        .from("amazon_removals")
        .select(removalSelect)
        .eq("organization_id", candidate.organization_id)
        .eq("store_id", candidate.store_id)
        .eq("order_id", orderId)
        .eq(key.col, key.val)
        .limit(8);
      traceNd(tracePath, {
        phase: "tier4_context_store",
        claim_candidate_id: candidate.id,
        key: key.col,
        error: error?.message,
        rows: data?.length ?? 0,
      });
      if (!error && (data?.length ?? 0) > 0) {
        return { rows: (data ?? []) as unknown as RemovalRow[], matchedVia: `context_order_${key.col}_store`, confidence: key.confidence };
      }
    }

    const { data, error } = await client
      .from("amazon_removals")
      .select(removalSelect)
      .eq("organization_id", candidate.organization_id)
      .eq("order_id", orderId)
      .eq(key.col, key.val)
      .limit(8);
    traceNd(tracePath, {
      phase: "tier4_context_org",
      claim_candidate_id: candidate.id,
      key: key.col,
      error: error?.message,
      rows: data?.length ?? 0,
    });
    if (!error && (data?.length ?? 0) > 0) {
      return { rows: (data ?? []) as unknown as RemovalRow[], matchedVia: `context_order_${key.col}`, confidence: key.confidence };
    }
  }
  return { rows: [], matchedVia: "none", confidence: 0 };
}

async function classifyCandidate(args: {
  client: SupabaseClient;
  candidate: CandidateRow;
  context: Record<string, unknown> | null;
  exactRemovals: Map<string, RemovalRow>;
  expectedById: Map<string, ExpectedPackageRow[]>;
  expectedByDetail: Map<string, ExpectedPackageRow[]>;
  expectedDetailRemovals: Map<string, RemovalRow>;
  removalSelect: string;
  removalHasAsin: boolean;
  tracePath: string;
}): Promise<ClassificationRow> {
  const c = args.candidate;
  const counts = candidateCounts();
  const reasonCodes: string[] = [];

  const exact = args.exactRemovals.get(c.source_row_id) ?? null;
  counts.exact_id = exact ? 1 : 0;
  if (exact) {
    reasonCodes.push("exact_id_hit");
    return resultRow({
      candidate: c,
      tier: 0,
      confidence: 1,
      ambiguityCount: 0,
      status: "already_current",
      reasonCode: "exact_id_hit",
      reasonCodes,
      matchedVia: "exact_id",
      matchedRow: exact,
      counts,
      requiresHumanReview: false,
      doNotApplyReason: "already_current_no_repair_needed",
    });
  }
  reasonCodes.push("exact_id_miss");

  const uploadStagingRows = await lookupUploadStaging(args.client, c, args.removalSelect, args.tracePath);
  counts.upload_staging = uploadStagingRows.length;
  if (uploadStagingRows.length === 1) {
    reasonCodes.push("upload_staging_unique");
    return resultRow({
      candidate: c,
      tier: 1,
      confidence: 0.98,
      ambiguityCount: 0,
      status: "repairable_unique",
      reasonCode: "upload_staging_unique",
      reasonCodes,
      matchedVia: "upload_staging",
      matchedRow: uploadStagingRows[0]!,
      counts,
      requiresHumanReview: false,
      doNotApplyReason: null,
    });
  }
  if (uploadStagingRows.length > 1) {
    reasonCodes.push("upload_staging_ambiguous");
    return resultRow({
      candidate: c,
      tier: 5,
      confidence: 0,
      ambiguityCount: uploadStagingRows.length,
      status: "ambiguous_manual_review",
      reasonCode: "upload_staging_ambiguous",
      reasonCodes,
      matchedVia: "upload_staging",
      matchedRow: null,
      counts,
      requiresHumanReview: true,
      doNotApplyReason: "ambiguous_upload_staging_match",
      extraEvidence: { ambiguous_rows_sample: firstRows(uploadStagingRows) },
    });
  }
  if (!c.upload_id || !c.source_staging_id) reasonCodes.push("missing_upload_or_source_staging_id");
  else reasonCodes.push("upload_staging_no_match");

  const expectedRows = [...(args.expectedById.get(c.source_row_id) ?? []), ...(args.expectedByDetail.get(c.source_row_id) ?? [])];
  const detailIds = [...new Set(expectedRows.map((r) => n(r.source_detail_row_id)).filter(Boolean) as string[])];
  const bridgedRows = detailIds.map((id) => args.expectedDetailRemovals.get(id)).filter(Boolean) as RemovalRow[];
  counts.expected_package_bridge = bridgedRows.length;
  if (bridgedRows.length === 1) {
    reasonCodes.push("expected_package_bridge_unique");
    return resultRow({
      candidate: c,
      tier: 2,
      confidence: 0.92,
      ambiguityCount: 0,
      status: "repairable_unique",
      reasonCode: "expected_package_bridge_unique",
      reasonCodes,
      matchedVia: "expected_package_bridge",
      matchedRow: bridgedRows[0]!,
      counts,
      requiresHumanReview: true,
      doNotApplyReason: "requires_expected_package_bridge_sample_review_before_write",
      extraEvidence: { expected_package_ids: expectedRows.map((r) => n(r.id)).filter(Boolean) },
    });
  }
  if (bridgedRows.length > 1) {
    reasonCodes.push("expected_package_bridge_ambiguous");
    return resultRow({
      candidate: c,
      tier: 5,
      confidence: 0,
      ambiguityCount: bridgedRows.length,
      status: "ambiguous_manual_review",
      reasonCode: "expected_package_bridge_ambiguous",
      reasonCodes,
      matchedVia: "expected_package_bridge",
      matchedRow: null,
      counts,
      requiresHumanReview: true,
      doNotApplyReason: "ambiguous_expected_package_bridge",
      extraEvidence: {
        expected_package_ids: expectedRows.map((r) => n(r.id)).filter(Boolean),
        ambiguous_rows_sample: firstRows(bridgedRows),
      },
    });
  }
  if (expectedRows.length > 0) reasonCodes.push("expected_package_bridge_dead_detail_or_no_live_match");
  else reasonCodes.push("expected_package_no_match");

  const business = await lookupBusinessKey(args.client, c, args.context, args.removalSelect, args.tracePath);
  counts.business_key = business.rows.length;
  if (business.rows.length === 1) {
    reasonCodes.push("business_key_unique");
    return resultRow({
      candidate: c,
      tier: 3,
      confidence: 0.88,
      ambiguityCount: 0,
      status: "repairable_unique",
      reasonCode: "business_key_unique",
      reasonCodes,
      matchedVia: "business_key",
      matchedRow: business.rows[0]!,
      counts,
      requiresHumanReview: true,
      doNotApplyReason: "requires_business_key_sample_review_before_write",
      extraEvidence: { business_key: business.key },
    });
  }
  if (business.rows.length > 1) {
    reasonCodes.push("business_key_ambiguous");
    return resultRow({
      candidate: c,
      tier: 5,
      confidence: 0,
      ambiguityCount: business.rows.length,
      status: "ambiguous_manual_review",
      reasonCode: "business_key_ambiguous",
      reasonCodes,
      matchedVia: "business_key",
      matchedRow: null,
      counts,
      requiresHumanReview: true,
      doNotApplyReason: "ambiguous_business_key_match",
      extraEvidence: { business_key: business.key, ambiguous_rows_sample: firstRows(business.rows) },
    });
  }
  reasonCodes.push(business.key ? "business_key_no_match" : "business_key_missing_required_fields");

  const ctx = await lookupContextIdentifier(
    args.client,
    c,
    args.context,
    args.removalSelect,
    args.removalHasAsin,
    args.tracePath,
  );
  counts.context_identifier = ctx.rows.length;
  if (ctx.rows.length === 1) {
    reasonCodes.push(`${ctx.matchedVia}_unique`);
    return resultRow({
      candidate: c,
      tier: 4,
      confidence: ctx.confidence,
      ambiguityCount: 0,
      status: "reviewable_unique_context",
      reasonCode: `${ctx.matchedVia}_unique`,
      reasonCodes,
      matchedVia: ctx.matchedVia,
      matchedRow: ctx.rows[0]!,
      counts,
      requiresHumanReview: true,
      doNotApplyReason: "context_identifier_match_requires_manual_review",
    });
  }
  if (ctx.rows.length > 1) {
    reasonCodes.push("context_identifier_ambiguous");
    return resultRow({
      candidate: c,
      tier: 5,
      confidence: 0,
      ambiguityCount: ctx.rows.length,
      status: "ambiguous_manual_review",
      reasonCode: "context_identifier_ambiguous",
      reasonCodes,
      matchedVia: ctx.matchedVia,
      matchedRow: null,
      counts,
      requiresHumanReview: true,
      doNotApplyReason: "ambiguous_context_identifier_match",
      extraEvidence: { ambiguous_rows_sample: firstRows(ctx.rows) },
    });
  }

  reasonCodes.push("no_live_evidence");
  return resultRow({
    candidate: c,
    tier: 6,
    confidence: 0,
    ambiguityCount: 0,
    status: "unrecoverable_no_live_evidence",
    reasonCode: "no_live_evidence",
    reasonCodes,
    matchedVia: "none",
    matchedRow: null,
    counts,
    requiresHumanReview: false,
    doNotApplyReason: "no_live_evidence_for_repair",
  });
}

function classificationCsvHeader(): string[] {
  return [
    "claim_candidate_id",
    "artifact_table",
    "organization_id",
    "store_id",
    "source_table",
    "old_source_row_id",
    "proposed_current_source_row_id",
    "proposed_source_upload_id",
    "upload_id",
    "proposed_source_staging_id",
    "evidence_tier",
    "confidence",
    "ambiguity_count",
    "repairability_status",
    "reason_code",
    "evidence_json",
    "requires_human_review",
    "do_not_apply_reason",
  ];
}

function classificationCsvRow(row: ClassificationRow): string[] {
  return [
    row.claim_candidate_id,
    row.artifact_table,
    row.organization_id,
    row.store_id ?? "",
    row.source_table,
    row.old_source_row_id,
    row.proposed_current_source_row_id ?? "",
    row.proposed_source_upload_id ?? "",
    row.upload_id ?? "",
    row.proposed_source_staging_id ?? "",
    String(row.evidence_tier),
    numCell(row.confidence),
    String(row.ambiguity_count),
    row.repairability_status,
    row.reason_code,
    jsonCell(row.evidence_json),
    boolCell(row.requires_human_review),
    row.do_not_apply_reason ?? "",
  ];
}

function writeClassificationCsv(filePath: string, rows: ClassificationRow[]): void {
  let out = rowToCsvLine(classificationCsvHeader());
  for (const row of rows) out += rowToCsvLine(classificationCsvRow(row));
  fs.writeFileSync(filePath, out, "utf8");
}

function writeTierCsv(filePath: string, rows: ClassificationRow[]): void {
  const tiers: { tier: Tier; name: string; status: RepairabilityStatus | "mixed"; deterministic: boolean; review: boolean }[] = [
    { tier: 0, name: "exact_current_amazon_removals_id", status: "already_current", deterministic: false, review: false },
    { tier: 1, name: "upload_id_source_staging_id_unique", status: "repairable_unique", deterministic: true, review: false },
    { tier: 2, name: "expected_packages_source_detail_row_id_bridge", status: "repairable_unique", deterministic: true, review: true },
    { tier: 3, name: "canonical_amazon_removals_business_key_unique", status: "repairable_unique", deterministic: true, review: true },
    { tier: 4, name: "claim_context_identifiers_unique", status: "reviewable_unique_context", deterministic: false, review: true },
    { tier: 5, name: "ambiguous_multiple_current_rows", status: "ambiguous_manual_review", deterministic: false, review: true },
    { tier: 6, name: "no_evidence_unrecoverable", status: "unrecoverable_no_live_evidence", deterministic: false, review: false },
  ];
  let out = rowToCsvLine([
    "tier",
    "tier_name",
    "row_count",
    "repairability_status",
    "deterministic_repair_candidate",
    "requires_human_review",
  ]);
  for (const tier of tiers) {
    out += rowToCsvLine([
      String(tier.tier),
      tier.name,
      String(rows.filter((r) => r.evidence_tier === tier.tier).length),
      tier.status,
      boolCell(tier.deterministic),
      boolCell(tier.review),
    ]);
  }
  fs.writeFileSync(filePath, out, "utf8");
}

function summarize(rows: ClassificationRow[], runId: string, outDir: string): Record<string, unknown> {
  const tierCounts: Record<string, number> = {};
  for (let i = 0; i <= 6; i++) tierCounts[String(i)] = 0;
  const statusCounts: Record<string, number> = {};
  const reasonCounts: Record<string, number> = {};
  for (const row of rows) {
    tierCounts[String(row.evidence_tier)] = (tierCounts[String(row.evidence_tier)] ?? 0) + 1;
    statusCounts[row.repairability_status] = (statusCounts[row.repairability_status] ?? 0) + 1;
    reasonCounts[row.reason_code] = (reasonCounts[row.reason_code] ?? 0) + 1;
  }
  const deterministic = rows.filter((r) => r.evidence_tier >= 1 && r.evidence_tier <= 3).length;
  const manual = rows.filter((r) => r.evidence_tier === 4 || r.evidence_tier === 5).length;
  const ambiguous = rows.filter((r) => r.evidence_tier === 5).length;
  const unrecoverable = rows.filter((r) => r.evidence_tier === 6).length;
  return {
    run_id: runId,
    generated_at: new Date().toISOString(),
    mode: "read_only",
    output_directory: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
    classifier_version: CLASSIFIER_VERSION,
    artifact_tables_scanned: ["claim_candidates"],
    source_table: "amazon_removals",
    total_analyzed: rows.length,
    total_rows_scanned: rows.length,
    deterministic_repair_count: deterministic,
    ambiguous_manual_count: manual,
    ambiguous_count: ambiguous,
    unrecoverable_count: unrecoverable,
    tier_counts: tierCounts,
    repairability_counts: statusCounts,
    reason_counts: reasonCounts,
    validation: {
      read_only_only: true,
      db_writes: false,
      sql_mutations: false,
      repairs_executed: false,
      migrations_created: false,
      claim_mutations: false,
      product_mutations: false,
      source_row_id_repairs: false,
      ai_or_external_api_calls: false,
      local_artifacts_only: true,
    },
  };
}

function writeValidation(outDir: string): void {
  const body = `# NEXT-CLAIM-17 Validation Results

- Read-only only: yes
- DB writes: none
- SQL mutations: none
- Repairs executed: none
- \`source_row_id\` mutations: none
- Migrations created: none
- Repair tables created: none
- Claim mutations: none
- Product writes: none
- AI/OpenAI calls: none
- External API calls: none
- Local audit artifacts written: yes
`;
  fs.writeFileSync(path.join(outDir, "validation-results.md"), body, "utf8");
}

function writeNextRecommendation(outDir: string, summary: Record<string, unknown>): void {
  const deterministic = Number(summary.deterministic_repair_count ?? 0);
  const ambiguousManual = Number(summary.ambiguous_manual_count ?? 0);
  const unrecoverable = Number(summary.unrecoverable_count ?? 0);
  const recommendation =
    deterministic > 0
      ? "Review deterministic Tier 1-3 samples before designing any repair ledger or migration."
      : unrecoverable > 0 && ambiguousManual === 0
        ? "Do not proceed to repair writes; current live evidence is insufficient for deterministic repair."
        : "Review manual and ambiguous samples before any repair-table design.";
  const body = `# NEXT-CLAIM-17 Next Step Recommendation

${recommendation}

## Recommended NEXT

NEXT-CLAIM-18 should remain read-only unless Tier 1-3 samples are manually approved.

If proceeding, use:

\`\`\`text
NEXT-CLAIM-18 - AMAZON_REMOVALS LINEAGE REPAIR REVIEW PACK (READ-ONLY)

Goal: Review NEXT-CLAIM-17 classifier outputs, sample deterministic and ambiguous rows, and decide whether a future append-only repair ledger migration is justified.

Hard constraints: no DB writes, no repairs, no source_row_id mutation, no migrations, no product writes, no AI/OpenAI or external API calls.
\`\`\`
`;
  fs.writeFileSync(path.join(outDir, "next-step-recommendation.md"), body, "utf8");
}

function writeManifest(outDir: string, runId: string, summary: Record<string, unknown>): void {
  const manifest = {
    prompt_name: "NEXT-CLAIM-17",
    run_id: runId,
    created_at_utc: new Date().toISOString(),
    mode: "read_only_repair_classifier",
    output_directory: path.relative(process.cwd(), outDir).replace(/\\/g, "/") + "/",
    classifier_version: CLASSIFIER_VERSION,
    required_outputs: REQUIRED_OUTPUTS,
    summary,
    validation: {
      no_db_writes: true,
      no_repairs: true,
      no_source_row_id_mutation: true,
      no_migrations: true,
      no_product_writes: true,
      local_artifacts_only: true,
    },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
}

async function main(): Promise<void> {
  loadEnvLocal();
  const args = parseArgs(process.argv.slice(2));
  const orgId = args.orgId?.trim();
  if (!orgId || !isUuidString(orgId)) {
    console.error("Required: --org-id=<uuid> (or --organization-id=<uuid>).");
    process.exitCode = 1;
    return;
  }

  const runId = args.runId ?? isoRunId();
  const outDir = path.resolve(".cursor", "audit-reports", "next-claim-17", runId);
  const logsDir = path.join(outDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const tracePath = path.join(logsDir, "claim17-repair-classifier.ndjson");
  fs.writeFileSync(tracePath, "", "utf8");
  traceNd(tracePath, { phase: "start", organization_id: orgId, classifier_version: CLASSIFIER_VERSION });

  const client = createServiceClient();
  const claimCandidatesSelect = await buildClaimCandidatesSelect(client, orgId, tracePath);
  const removalSelect = await buildRemovalSelect(client, orgId, tracePath);
  const removalHasAsin = removalSelect.split(",").map((x) => x.trim()).includes("asin");

  const allRows: ClassificationRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await client
      .from("claim_candidates")
      .select(claimCandidatesSelect)
      .eq("organization_id", orgId)
      .ilike("source_table", "amazon_removals")
      .not("source_row_id", "is", null)
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);

    traceNd(tracePath, { phase: "fetch_claim_candidates", from, to: from + PAGE - 1, error: error?.message, rows: data?.length ?? 0 });
    if (error) {
      throw new Error(`claim_candidates SELECT failed: ${error.message}`);
    }
    const batch = ((data ?? []) as unknown as Record<string, unknown>[])
      .map((r) => toCandidateRow(r, orgId))
      .filter(Boolean) as CandidateRow[];
    if (batch.length === 0) break;

    const candidateIds = batch.map((r) => r.id);
    const sourceRowIds = batch.map((r) => r.source_row_id);
    const exactRemovals = await fetchRemovalRowsByIds(client, sourceRowIds, orgId, removalSelect, tracePath);
    const contexts = await fetchCandidateSourceContext(client, candidateIds, tracePath);
    const expectedById = await fetchExpectedPackagesByColumn(client, sourceRowIds, orgId, "id", tracePath);
    const expectedByDetail = await fetchExpectedPackagesByColumn(client, sourceRowIds, orgId, "source_detail_row_id", tracePath);
    const expectedDetailIds = [
      ...new Set(
        [...expectedById.values(), ...expectedByDetail.values()]
          .flat()
          .map((r) => n(r.source_detail_row_id))
          .filter(Boolean) as string[],
      ),
    ];
    const expectedDetailRemovals = await fetchRemovalRowsByIds(client, expectedDetailIds, orgId, removalSelect, tracePath);

    for (const candidate of batch) {
      const context = contexts.get(candidate.id) ?? null;
      const row = await classifyCandidate({
        client,
        candidate,
        context,
        exactRemovals,
        expectedById,
        expectedByDetail,
        expectedDetailRemovals,
        removalSelect,
        removalHasAsin,
        tracePath,
      });
      allRows.push(row);
      traceNd(tracePath, {
        phase: "classified",
        claim_candidate_id: row.claim_candidate_id,
        tier: row.evidence_tier,
        status: row.repairability_status,
        reason_code: row.reason_code,
      });
    }

    if ((data ?? []).length < PAGE) break;
    from += PAGE;
  }

  const summary = summarize(allRows, runId, outDir);
  fs.writeFileSync(path.join(outDir, "00-classifier-summary.json"), JSON.stringify(summary, null, 2), "utf8");
  writeTierCsv(path.join(outDir, "01-repairability-by-tier.csv"), allRows);
  writeClassificationCsv(
    path.join(outDir, "02-deterministic-repair-candidates.csv"),
    allRows.filter((r) => r.evidence_tier >= 1 && r.evidence_tier <= 3),
  );
  writeClassificationCsv(
    path.join(outDir, "03-ambiguous-repair-candidates.csv"),
    allRows.filter((r) => r.evidence_tier === 5),
  );
  writeClassificationCsv(
    path.join(outDir, "04-unrecoverable-candidates.csv"),
    allRows.filter((r) => r.evidence_tier === 6),
  );
  writeClassificationCsv(
    path.join(outDir, "05-manual-review-sample.csv"),
    allRows.filter((r) => r.requires_human_review || r.evidence_tier === 6).slice(0, SAMPLE_LIMIT),
  );
  writeValidation(outDir);
  writeNextRecommendation(outDir, summary);
  writeManifest(outDir, runId, summary);
  traceNd(tracePath, { phase: "done", summary });

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exitCode = 1;
});
