import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { assessReportsApiPipelineCompletion } from "./reports-api-pipeline-completion";
import { parseSourceRun } from "./reports-api-source-run";
import {
  DEFAULT_SETTLEMENT_FRR_SAMPLE_LIMIT,
  MAX_SETTLEMENT_FRR_SAMPLE_LIMIT,
  type SettlementFrrLineSample,
  type SettlementFrrReconciliationCounts,
  type SettlementFrrReconciliationError,
  type SettlementFrrReconciliationHealth,
  type SettlementFrrReconciliationPayload,
  type SettlementFrrSourceRunSummary,
} from "./settlement-frr-reconciliation-types";

const SETTLEMENT_SELECT =
  "id, settlement_id, amazon_line_key, order_id, sku, posted_date, transaction_type, amount_total";
const FRR_SELECT = "id, source_row_id, trid_key, confidence_score";
const SID_PAGE = 1000;
const IN_CHUNK = 100;

function clampSampleLimit(n: number | undefined): number {
  const raw = n ?? DEFAULT_SETTLEMENT_FRR_SAMPLE_LIMIT;
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_SETTLEMENT_FRR_SAMPLE_LIMIT;
  return Math.min(Math.floor(raw), MAX_SETTLEMENT_FRR_SAMPLE_LIMIT);
}

function sourceRunSummary(metadata: unknown): SettlementFrrSourceRunSummary | null {
  const sr = parseSourceRun(metadata);
  if (!sr) return null;
  return {
    source_run_id: sr.source_run_id,
    state: sr.state,
    report_id: sr.external_ids?.report_id ?? null,
    report_document_id: sr.external_ids?.report_document_id ?? null,
    window_start: sr.window?.start ?? null,
    window_end: sr.window?.end ?? null,
  };
}

function toLineSample(
  row: Record<string, unknown>,
  frr: Record<string, unknown> | null,
  match_status: SettlementFrrLineSample["match_status"],
): SettlementFrrLineSample {
  const amount = row.amount_total;
  return {
    settlement_row_id: String(row.id ?? ""),
    settlement_id: row.settlement_id != null ? String(row.settlement_id) : null,
    amazon_line_key: row.amazon_line_key != null ? String(row.amazon_line_key) : null,
    order_id: row.order_id != null ? String(row.order_id) : null,
    sku: row.sku != null ? String(row.sku) : null,
    posted_date: row.posted_date != null ? String(row.posted_date) : null,
    transaction_type: row.transaction_type != null ? String(row.transaction_type) : null,
    amount_total:
      typeof amount === "number" && Number.isFinite(amount)
        ? amount
        : amount != null
          ? Number(amount)
          : null,
    frr_id: frr?.id != null ? String(frr.id) : null,
    trid_key: frr?.trid_key != null ? String(frr.trid_key) : null,
    confidence_score:
      typeof frr?.confidence_score === "number" && Number.isFinite(frr.confidence_score)
        ? frr.confidence_score
        : frr?.confidence_score != null
          ? Number(frr.confidence_score)
          : null,
    match_status,
  };
}

function deriveHealth(counts: SettlementFrrReconciliationCounts): SettlementFrrReconciliationHealth {
  if (counts.settlement_rows === 0) return "no_domain_rows";
  if (
    counts.unmatched_settlement_rows === 0 &&
    counts.duplicate_frr_rows === 0 &&
    counts.trid_collision_groups === 0 &&
    counts.staging_remaining === 0 &&
    counts.frr_linked >= counts.settlement_rows
  ) {
    return "fully_reconciled";
  }
  return "has_gaps";
}

async function countFrrRowsForSettlementIds(
  supabase: SupabaseClient,
  organizationId: string,
  settlementIds: string[],
): Promise<{ frrRows: Record<string, unknown>[]; error: string | null }> {
  const all: Record<string, unknown>[] = [];
  for (let i = 0; i < settlementIds.length; i += IN_CHUNK) {
    const part = settlementIds.slice(i, i + IN_CHUNK);
    const { data, error } = await supabase
      .from("financial_reference_resolver")
      .select("id, source_row_id, trid_key")
      .eq("organization_id", organizationId)
      .eq("source_table", "amazon_settlements")
      .in("source_row_id", part);
    if (error) return { frrRows: [], error: error.message };
    all.push(...((data ?? []) as Record<string, unknown>[]));
  }
  return { frrRows: all, error: null };
}

export async function computeSettlementFrrReconciliation(
  supabase: SupabaseClient,
  organizationId: string,
  uploadId: string,
  options?: { sampleLimit?: number },
): Promise<SettlementFrrReconciliationPayload | SettlementFrrReconciliationError> {
  const sampleLimit = clampSampleLimit(options?.sampleLimit);

  const { data: upload, error: upErr } = await supabase
    .from("raw_report_uploads")
    .select("id, organization_id, file_name, report_type, status, metadata")
    .eq("id", uploadId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (upErr) return { ok: false, error: upErr.message, code: "upload_read_failed" };
  if (!upload) return { ok: false, error: "Upload not found.", code: "upload_not_found" };

  const reportType = String(upload.report_type ?? "").trim();
  if (reportType !== "SETTLEMENT") {
    return {
      ok: false,
      error: "Reconciliation is only available for SETTLEMENT uploads.",
      code: "not_settlement",
    };
  }

  const completion = await assessReportsApiPipelineCompletion(
    supabase,
    organizationId,
    uploadId,
    reportType,
  );

  const meta = upload.metadata;
  const uploadSource =
    meta && typeof meta === "object" && !Array.isArray(meta) && typeof (meta as { source?: unknown }).source === "string"
      ? String((meta as { source: string }).source)
      : null;

  const matchedSettlementIds = new Set<string>();
  const tridKeyToRowIds = new Map<string, Set<string>>();
  let frrRowCount = 0;
  let duplicateFrrRows = 0;
  let tridCollisionGroups = 0;

  const samples = {
    matched: [] as SettlementFrrLineSample[],
    unmatched: [] as SettlementFrrLineSample[],
    conflicts: [] as SettlementFrrLineSample[],
  };

  let lastSid: string | null = null;

  for (;;) {
    let sidQ = supabase
      .from("amazon_settlements")
      .select(SETTLEMENT_SELECT)
      .eq("organization_id", organizationId)
      .eq("upload_id", uploadId)
      .order("id", { ascending: true })
      .limit(SID_PAGE);
    if (lastSid) sidQ = sidQ.gt("id", lastSid);

    const { data: sidPage, error: sidErr } = await sidQ;
    if (sidErr) return { ok: false, error: sidErr.message, code: "settlement_read_failed" };

    const settlements = (sidPage ?? []) as Record<string, unknown>[];
    if (!settlements.length) break;

    lastSid = String(settlements[settlements.length - 1]?.id ?? "") || lastSid;

    const frrBySourceId = new Map<string, Record<string, unknown>[]>();

    const pageIds = settlements.map((r) => String(r.id ?? "")).filter(Boolean);
    const { frrRows: pageFrr, error: frrErr } = await countFrrRowsForSettlementIds(
      supabase,
      organizationId,
      pageIds,
    );
    if (frrErr) return { ok: false, error: frrErr, code: "frr_read_failed" };

    for (const frr of pageFrr) {
      const sid = String(frr.source_row_id ?? "");
      if (!sid) continue;
      frrRowCount += 1;
      const list = frrBySourceId.get(sid) ?? [];
      list.push(frr);
      frrBySourceId.set(sid, list);
    }

    for (const s of settlements) {
      const sid = String(s.id ?? "");
      if (!sid) continue;
      const frrList = frrBySourceId.get(sid) ?? [];

      if (frrList.length === 0) {
        if (samples.unmatched.length < sampleLimit) {
          samples.unmatched.push(toLineSample(s, null, "unmatched"));
        }
        continue;
      }

      matchedSettlementIds.add(sid);
      if (frrList.length > 1) {
        duplicateFrrRows += frrList.length - 1;
        for (const frr of frrList) {
          if (samples.conflicts.length < sampleLimit) {
            samples.conflicts.push(toLineSample(s, frr, "duplicate_frr"));
          }
        }
      }

      const primary = frrList[0]!;
      const trid = String(primary.trid_key ?? "");
      if (trid) {
        const group = tridKeyToRowIds.get(trid) ?? new Set<string>();
        if (!group.has(sid)) {
          group.add(sid);
          tridKeyToRowIds.set(trid, group);
        }
      }

      if (samples.matched.length < sampleLimit) {
        samples.matched.push(toLineSample(s, primary, "matched"));
      }
    }

    if (settlements.length < SID_PAGE) break;
  }

  for (const [, rowIds] of tridKeyToRowIds) {
    if (rowIds.size > 1) tridCollisionGroups += 1;
  }

  const settlementRows = completion.domain_rows;
  const skipDeepCollisionScan =
    settlementRows > 0 &&
    matchedSettlementIds.size === settlementRows &&
    frrRowCount === settlementRows &&
    duplicateFrrRows === 0;
  if (skipDeepCollisionScan) {
    tridCollisionGroups = 0;
  }
  const unmatched = Math.max(0, settlementRows - matchedSettlementIds.size);

  const counts: SettlementFrrReconciliationCounts = {
    settlement_rows: settlementRows,
    frr_linked: frrRowCount,
    unmatched_settlement_rows: unmatched,
    duplicate_frr_rows: duplicateFrrRows,
    trid_collision_groups: tridCollisionGroups,
    staging_remaining: completion.staging_rows,
  };

  return {
    ok: true,
    upload_id: uploadId,
    organization_id: organizationId,
    file_name: String(upload.file_name ?? ""),
    upload_status: String(upload.status ?? ""),
    report_type: reportType,
    upload_source: uploadSource,
    source_run: sourceRunSummary(upload.metadata),
    counts,
    health: deriveHealth(counts),
    samples,
  };
}
