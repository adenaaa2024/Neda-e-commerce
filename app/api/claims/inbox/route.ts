import { NextResponse } from "next/server";
import { assertUserCanAccessOrganization } from "../../../dashboard/products/pim-actions";
import {
  claimInboxStr,
  projectClaimCandidatesBatch,
  type InboxQueue,
  type ProjectedCandidate,
} from "../../../../lib/claim-inbox-projection";
import { getClaimInboxListSelect } from "../../../../lib/claim-inbox-schema";
import { assertStoreBelongsToOrganization } from "../../../../lib/claim-org-scope";
import { buildProductLinkageDisplayContracts } from "../../../../lib/product-linkage-display-enrich";
import type { ProductLinkageDisplayContract } from "../../../../lib/product-linkage-display-contract";
import {
  isValidIntakeSourceFilter,
  sourceTablesForIntakeFilter,
  type IntakeSourceFilter,
} from "../../../../lib/claim-intake-source-filter";
import { supabaseServer } from "../../../../lib/supabase-server";
import { isUuidString } from "../../../../lib/uuid";

const INBOX_QUEUES = new Set<InboxQueue>([
  "legacy_source_broken",
  "pim_blocked",
  "evidence_missing",
  "ready_for_review",
  "needs_product_link",
  "ineligible_pre_cutoff",
]);

const MAX_PAGE_SIZE = 100;
const SCAN_BATCH = 120;
const MAX_SCAN_ROWS = 4000;

const LEGACY_SOURCE_BROKEN_MESSAGE =
  "This claim candidate points to an older Amazon removal source row that no longer exists in the current operational table. The system cannot safely auto-repair the source link.";

type PageCursor = { m: "p"; page: number };
type ScanCursor = { m: "s"; offset: number };

function encodeCursorJson(obj: PageCursor | ScanCursor): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

function decodeCursor(raw: string | null): PageCursor | ScanCursor | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { m?: string; page?: unknown; offset?: unknown };
    if (o?.m === "p" && typeof o.page === "number" && o.page >= 1) return { m: "p", page: Math.floor(o.page) };
    if (o?.m === "s" && typeof o.offset === "number" && o.offset >= 0) return { m: "s", offset: Math.floor(o.offset) };
  } catch {
    /* ignore */
  }
  return null;
}

function clampPageSize(raw: string | null): number {
  const n = Number.parseInt(raw ?? "25", 10) || 25;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, n));
}

function buildBaseQuery(organizationId: string, url: URL, listSelect: string) {
  const storeId = String(url.searchParams.get("store_id") ?? "").trim();
  const sourceTable = String(url.searchParams.get("source_table") ?? "").trim();
  const evidenceStatus = String(url.searchParams.get("evidence_status") ?? "").trim();
  const claimFamily = String(url.searchParams.get("claim_family") ?? "").trim().slice(0, 200);
  const claimReason = String(url.searchParams.get("claim_reason") ?? "").trim().slice(0, 400);
  const search = String(url.searchParams.get("search") ?? "").trim().slice(0, 80);

  let q = supabaseServer
    .from("claim_candidates")
    .select(listSelect)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

  if (storeId) {
    if (!isUuidString(storeId)) return { ok: false as const, error: "store_id must be a UUID when provided." };
    q = q.eq("store_id", storeId);
  }
  const intakeSourceRaw = String(url.searchParams.get("intake_source") ?? "").trim();
  if (intakeSourceRaw && isValidIntakeSourceFilter(intakeSourceRaw)) {
    const tables = sourceTablesForIntakeFilter(intakeSourceRaw as IntakeSourceFilter);
    if (tables === "physical_only") {
      return { ok: true as const, q, storeId: storeId || null, physical_only: true as const };
    }
    if (Array.isArray(tables) && tables.length > 0) {
      q = q.in("source_table", tables);
    }
  } else if (sourceTable) {
    q = q.eq("source_table", sourceTable);
  }
  if (evidenceStatus) q = q.eq("evidence_status", evidenceStatus);
  if (claimFamily) q = q.eq("claim_family", claimFamily);
  if (claimReason) q = q.eq("claim_reason", claimReason);
  if (search) {
    const pat = `%${search.replace(/%/g, "").replace(/,/g, "")}%`;
    q = q.or(`sku.ilike.${pat},fnsku.ilike.${pat},asin.ilike.${pat}`);
  }
  return { ok: true as const, q, storeId: storeId || null };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const organizationId = String(url.searchParams.get("organization_id") ?? "").trim();
  if (!isUuidString(organizationId)) {
    return NextResponse.json({ error: "organization_id must be a UUID." }, { status: 400 });
  }

  const gate = await assertUserCanAccessOrganization(organizationId);
  if (!gate.ok) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.error === "Not signed in." ? 401 : 403 },
    );
  }

  const storeIdParam = String(url.searchParams.get("store_id") ?? "").trim();
  if (storeIdParam) {
    if (!isUuidString(storeIdParam)) {
      return NextResponse.json({ error: "store_id must be a UUID when provided." }, { status: 400 });
    }
    const storeOk = await assertStoreBelongsToOrganization(organizationId, storeIdParam);
    if (!storeOk.ok) {
      return NextResponse.json({ error: storeOk.error }, { status: storeOk.status });
    }
  }

  const pageSize = clampPageSize(url.searchParams.get("pageSize") ?? url.searchParams.get("page_size"));
  const queueRaw = String(url.searchParams.get("queue") ?? "").trim() as InboxQueue | "";
  const queue = queueRaw && INBOX_QUEUES.has(queueRaw as InboxQueue) ? (queueRaw as InboxQueue) : null;

  const rawCursor = url.searchParams.get("cursor")?.trim() || null;
  const decoded = decodeCursor(rawCursor);
  const pageParam = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);

  try {
    const listSelect = await getClaimInboxListSelect(supabaseServer);
    const builtProbe = buildBaseQuery(organizationId, url, listSelect);
    if (!builtProbe.ok) return NextResponse.json({ error: builtProbe.error }, { status: 400 });
    if ("physical_only" in builtProbe && builtProbe.physical_only) {
      return NextResponse.json({ items: [], next_cursor: null, intake_source: "physical_return" });
    }

    if (queue) {
      const startOffset = decoded?.m === "s" ? decoded.offset : 0;
      const collected: Record<string, unknown>[] = [];
      let scan = startOffset;
      let scanned = 0;
      let lastBatchLen = 0;

      while (collected.length < pageSize && scanned < MAX_SCAN_ROWS) {
        const built = buildBaseQuery(organizationId, url, listSelect);
        if (!built.ok) return NextResponse.json({ error: built.error }, { status: 400 });
        if ("physical_only" in built && built.physical_only) break;
        const { data, error } = await built.q.range(scan, scan + SCAN_BATCH - 1);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        const batch = ((data ?? []) as unknown) as unknown as Record<string, unknown>[];
        lastBatchLen = batch.length;
        if (batch.length === 0) break;
        scanned += batch.length;
        const proj = await projectClaimCandidatesBatch(supabaseServer, batch, organizationId);
        for (const row of batch) {
          const id = claimInboxStr(row.id);
          if (!id) continue;
          const p = proj.get(id);
          if (p?.inbox_queue !== queue) continue;
          collected.push(row);
          if (collected.length >= pageSize) break;
        }
        scan += batch.length;
        if (batch.length < SCAN_BATCH) break;
      }

      const projOut = await projectClaimCandidatesBatch(supabaseServer, collected, organizationId);
      const items = await shapeListItemsWithLinkage(organizationId, collected, projOut);
      const hasMoreDbRows = lastBatchLen === SCAN_BATCH && scanned < MAX_SCAN_ROWS;
      const next_cursor =
        (collected.length === pageSize || (collected.length < pageSize && hasMoreDbRows)) && lastBatchLen > 0
          ? encodeCursorJson({ m: "s", offset: scan })
          : null;

      return NextResponse.json({
        items,
        next_cursor,
      });
    }

    const builtPage = buildBaseQuery(organizationId, url, listSelect);
    if (!builtPage.ok) return NextResponse.json({ error: builtPage.error }, { status: 400 });
    const page = decoded?.m === "p" ? decoded.page : pageParam;
    const from = (page - 1) * pageSize;
    const { data, error } = await builtPage.q.range(from, from + pageSize - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const batch = ((data ?? []) as unknown) as unknown as Record<string, unknown>[];
    const proj = await projectClaimCandidatesBatch(supabaseServer, batch, organizationId);
    const items = await shapeListItemsWithLinkage(organizationId, batch, proj);
    const next_cursor =
      batch.length === pageSize ? encodeCursorJson({ m: "p", page: page + 1 }) : null;

    return NextResponse.json({ items, next_cursor });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Query failed.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

async function shapeListItemsWithLinkage(
  organizationId: string,
  rows: Record<string, unknown>[],
  proj: Map<string, ProjectedCandidate>,
) {
  const inputs = rows.map((row) => ({
    source_table: claimInboxStr(row.source_table) ?? "claim_candidates",
    source_row_id: claimInboxStr(row.source_row_id) ?? claimInboxStr(row.id) ?? "",
    row,
  }));
  const linkages = await buildProductLinkageDisplayContracts(organizationId, inputs);
  return rows.map((row, i) =>
    shapeListItem(row, proj.get(claimInboxStr(row.id) ?? "") ?? null, linkages[i] ?? null),
  );
}

function shapeListItem(
  row: Record<string, unknown>,
  proj: ProjectedCandidate | null,
  product_linkage: ProductLinkageDisplayContract | null,
) {
  const id = claimInboxStr(row.id);
  const inboxQueue = proj?.inbox_queue ?? ("needs_product_link" as const);
  const lineageWarningCode = proj?.lineage_warning_code ?? null;
  const legacySourceBroken =
    inboxQueue === "legacy_source_broken" || lineageWarningCode === "stale_or_wrong_source_row_id";
  return {
    id,
    organization_id: claimInboxStr(row.organization_id),
    store_id: claimInboxStr(row.store_id),
    source_table: claimInboxStr(row.source_table),
    source_row_id: claimInboxStr(row.source_row_id),
    sku: claimInboxStr(row.sku),
    fnsku: claimInboxStr(row.fnsku),
    asin: claimInboxStr(row.asin),
    product_id: claimInboxStr(row.product_id),
    resolved_product_id: claimInboxStr(row.resolved_product_id),
    candidate_status: claimInboxStr(row.candidate_status),
    evidence_status: claimInboxStr(row.evidence_status),
    confidence_score: row.confidence_score ?? null,
    claim_family: claimInboxStr(row.claim_family),
    claim_reason: claimInboxStr(row.claim_reason),
    created_at: row.created_at ?? null,
    inbox_queue: inboxQueue,
    queue_label: queueLabel(inboxQueue),
    badges: proj?.badges ?? [],
    lineage_warning_code: lineageWarningCode,
    lineage_warning_message: legacySourceBroken ? LEGACY_SOURCE_BROKEN_MESSAGE : null,
    source_lineage_status: legacySourceBroken ? "legacy_source_broken" : "source_lineage_ok_or_unknown",
    automation_allowed: proj?.automation_allowed ?? false,
    product_linkage,
  };
}

function queueLabel(q: string): string {
  const m: Record<string, string> = {
    ready_for_review: "Ready for review",
    evidence_missing: "Evidence missing",
    needs_product_link: "Needs product link",
    pim_blocked: "PIM blocked",
    legacy_source_broken: "Legacy source broken",
    ineligible_pre_cutoff: "Before claim start date",
  };
  return m[q] ?? q.replace(/_/g, " ");
}
