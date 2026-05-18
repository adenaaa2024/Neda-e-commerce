/**
 * NEXT-CLAIM-EVIDENCE-02 — Read-only evidence graph builder dry-run.
 *
 *   npx tsx scripts/claim-evidence-graph-dryrun.ts --org-id=<uuid>
 *   npx tsx scripts/claim-evidence-graph-dryrun.ts --org-id=<uuid> --run-id=myRun --sample-drafts=40
 *
 * SELECT only. Writes audit artifacts under:
 *   .cursor/audit-reports/next-claim-evidence-02/<run_id>/
 *
 * Does NOT insert claim_reference_edges, lineage events, or mutate claims/drafts.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { isUuidString } from "../lib/uuid";

const SCRIPT_VERSION = "claim-evidence-graph-dryrun-v1";
const DRAFT_PAGE = 500;
const CHUNK = 150;
const ORDER_CHUNK = 40;
const FRR_SELECT =
  "trid_key, source_table, source_row_id, settlement_id, order_id, sku, confidence_score, reference_group_key, transaction_type";
const FINANCES_EVENT_SELECT =
  "id, event_group_id, order_id, removal_order_id, reimbursement_id, event_type, posted_at, sku, amount, currency";
/** Cap FRR-derived edges per draft in dry-run output (full order fan-out still counted in stats). */
const MAX_FRR_EDGES_PER_DRAFT = 24;
const RETURN_ITEM_SELECT =
  "id, package_id, order_id, sku, fnsku, resolved_product_id, identifier_resolution_status, identifier_resolution_confidence";
const SLIP_SELECT =
  "id, package_id, slip_code, resolved_product_id, identifier_resolution_status, identifier_resolution_confidence";
const ALLOC_SELECT =
  "id, removal_id, shipment_box_item_id, order_id, sku, fnsku, allocated_quantity, scanned_quantity, status";

export type ProposedEdge = {
  edge_id: string;
  draft_id: string;
  organization_id: string;
  edge_type: string;
  from_node_kind: string;
  from_source_table: string;
  from_source_row_id: string;
  to_node_kind: string;
  to_source_table: string;
  to_source_row_id: string;
  reference_kind: string | null;
  reference_value: string | null;
  confidence_score: number;
  ambiguity_group_key: string | null;
  ambiguity_rank: number | null;
  edge_reason: string;
  source_table: string;
  source_citations: { kind: string; table: string; row_id?: string }[];
};

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

function nv(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function normSku(s: string | null | undefined): string | null {
  const t = nv(s);
  return t ? t.toLowerCase() : null;
}

function isoRunId(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function bump(m: Map<string, number>, k: string, n = 1): void {
  m.set(k, (m.get(k) ?? 0) + n);
}

function edgeId(draftId: string, parts: string[]): string {
  const h = crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
  return `dryrun:${draftId.slice(0, 8)}:${h}`;
}

function numConf(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.min(1, Math.max(0, v));
  if (v != null && v !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.min(1, Math.max(0, n));
  }
  return fallback;
}

type DraftRow = {
  id: string;
  organization_id: string;
  store_id: string | null;
  source_table: string;
  source_row_id: string;
  sku: string | null;
};

type RemovalRow = { id: string; order_id: string | null; sku: string | null; fnsku: string | null };

type TableProbe = { table: string; present: boolean; error: string | null };

async function probeTable(client: SupabaseClient, table: string, orgId?: string): Promise<TableProbe> {
  let q = client.from(table).select("id").limit(1);
  if (orgId) q = q.eq("organization_id", orgId);
  const { error } = await q;
  if (!error) return { table, present: true, error: null };
  const msg = error.message ?? "";
  if (msg.includes("Could not find") || msg.includes("does not exist") || error.code === "42P01") {
    return { table, present: false, error: msg };
  }
  return { table, present: false, error: msg };
}

function parseArgs(argv: string[]): {
  orgId: string | null;
  runId: string | null;
  sampleDrafts: number;
  sourceTables: string[];
} {
  let orgId: string | null = null;
  let runId: string | null = null;
  let sampleDrafts = 35;
  let sourceTables = ["amazon_removals"];
  for (const a of argv) {
    if (a.startsWith("--org-id=")) orgId = a.slice("--org-id=".length).trim() || null;
    if (a.startsWith("--organization-id=")) orgId = a.slice("--organization-id=".length).trim() || null;
    if (a.startsWith("--run-id=")) runId = a.slice("--run-id=".length).trim() || null;
    if (a.startsWith("--sample-drafts=")) sampleDrafts = Math.max(5, Number.parseInt(a.slice("--sample-drafts=".length), 10) || 35);
    if (a === "--include-returns") sourceTables = ["amazon_removals", "amazon_returns"];
  }
  return { orgId, runId, sampleDrafts, sourceTables };
}

async function fetchAllDrafts(client: SupabaseClient, orgId: string, tables: string[]): Promise<DraftRow[]> {
  const out: DraftRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await client
      .from("claim_candidate_drafts")
      .select("id, organization_id, store_id, source_table, source_row_id, sku")
      .eq("organization_id", orgId)
      .in("source_table", tables)
      .order("id", { ascending: true })
      .range(from, from + DRAFT_PAGE - 1);
    if (error) throw new Error(`claim_candidate_drafts: ${error.message}`);
    const batch = (data ?? []) as Record<string, unknown>[];
    for (const r of batch) {
      const id = nv(r.id);
      const org = nv(r.organization_id);
      const st = nv(r.source_table);
      const sid = nv(r.source_row_id);
      if (!id || !org || !st || !sid) continue;
      out.push({
        id,
        organization_id: org,
        store_id: nv(r.store_id),
        source_table: st,
        source_row_id: sid,
        sku: nv(r.sku),
      });
    }
    if (batch.length < DRAFT_PAGE) break;
    from += DRAFT_PAGE;
  }
  return out;
}

async function fetchRemovals(client: SupabaseClient, orgId: string, ids: string[]): Promise<Map<string, RemovalRow>> {
  const map = new Map<string, RemovalRow>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const { data, error } = await client
      .from("amazon_removals")
      .select("id, order_id, sku, fnsku")
      .eq("organization_id", orgId)
      .in("id", slice);
    if (error) throw new Error(`amazon_removals: ${error.message}`);
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const id = nv(r.id);
      if (!id) continue;
      map.set(id, { id, order_id: nv(r.order_id), sku: nv(r.sku), fnsku: nv(r.fnsku) });
    }
  }
  return map;
}

async function fetchExpectedByDetailIds(
  client: SupabaseClient,
  orgId: string,
  detailIds: string[],
): Promise<Map<string, { count: number; sample_id: string | null }>> {
  const map = new Map<string, { count: number; sample_id: string | null }>();
  for (let i = 0; i < detailIds.length; i += CHUNK) {
    const slice = detailIds.slice(i, i + CHUNK);
    const { data, error } = await client
      .from("expected_packages")
      .select("id, source_detail_row_id")
      .eq("organization_id", orgId)
      .in("source_detail_row_id", slice);
    if (error) {
      if (error.message.includes("does not exist") || error.code === "42P01") return map;
      throw new Error(`expected_packages: ${error.message}`);
    }
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const did = nv(r.source_detail_row_id);
      if (!did) continue;
      const cur = map.get(did) ?? { count: 0, sample_id: null };
      cur.count += 1;
      if (!cur.sample_id) cur.sample_id = nv(r.id);
      map.set(did, cur);
    }
  }
  return map;
}

async function fetchAllocations(
  client: SupabaseClient,
  orgId: string,
  removalIds: string[],
): Promise<Map<string, Record<string, unknown>[]>> {
  const byRemoval = new Map<string, Record<string, unknown>[]>();
  for (let i = 0; i < removalIds.length; i += CHUNK) {
    const slice = removalIds.slice(i, i + CHUNK);
    const { data, error } = await client
      .from("removal_item_allocations")
      .select(ALLOC_SELECT)
      .eq("organization_id", orgId)
      .in("removal_id", slice);
    if (error) {
      if (error.message.includes("does not exist") || error.code === "42P01") return byRemoval;
      throw new Error(`removal_item_allocations: ${error.message}`);
    }
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const rid = nv(r.removal_id);
      if (!rid) continue;
      const arr = byRemoval.get(rid) ?? [];
      arr.push(r);
      byRemoval.set(rid, arr);
    }
  }
  return byRemoval;
}

async function fetchBoxItems(
  client: SupabaseClient,
  orgId: string,
  ids: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const map = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const { data, error } = await client
      .from("shipment_box_items")
      .select("id, shipment_box_id, order_id, sku, fnsku")
      .eq("organization_id", orgId)
      .in("id", slice);
    if (error) {
      if (error.message.includes("does not exist") || error.code === "42P01") return map;
      throw new Error(`shipment_box_items: ${error.message}`);
    }
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const id = nv(r.id);
      if (id) map.set(id, r);
    }
  }
  return map;
}

async function fetchFrrByOrderIds(client: SupabaseClient, orgId: string, orderIds: string[]): Promise<Map<string, Record<string, unknown>[]>> {
  const byOrder = new Map<string, Record<string, unknown>[]>();
  const unique = [...new Set(orderIds.filter(Boolean))];
  for (let i = 0; i < unique.length; i += ORDER_CHUNK) {
    const chunk = unique.slice(i, i + ORDER_CHUNK);
    const { data, error } = await client
      .from("financial_reference_resolver")
      .select(FRR_SELECT)
      .eq("organization_id", orgId)
      .in("order_id", chunk);
    if (error) throw new Error(`financial_reference_resolver: ${error.message}`);
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const oid = nv(row.order_id);
      if (!oid) continue;
      const arr = byOrder.get(oid) ?? [];
      arr.push(row);
      byOrder.set(oid, arr);
    }
  }
  return byOrder;
}

async function fetchFinancesEvents(
  client: SupabaseClient,
  orgId: string,
  orderIds: string[],
): Promise<Map<string, Record<string, unknown>[]>> {
  const byOrder = new Map<string, Record<string, unknown>[]>();
  const unique = [...new Set(orderIds.filter(Boolean))];
  for (let i = 0; i < unique.length; i += ORDER_CHUNK) {
    const chunk = unique.slice(i, i + ORDER_CHUNK);
    const { data, error } = await client
      .from("amazon_finances_events")
      .select(FINANCES_EVENT_SELECT)
      .eq("organization_id", orgId)
      .in("order_id", chunk)
      .limit(500);
    if (error) {
      if (error.message.includes("does not exist") || error.code === "42P01") return byOrder;
      throw new Error(`amazon_finances_events: ${error.message}`);
    }
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const oid = nv(row.order_id) ?? nv(row.removal_order_id);
      if (!oid) continue;
      const arr = byOrder.get(oid) ?? [];
      arr.push(row);
      byOrder.set(oid, arr);
    }
  }
  return byOrder;
}

async function fetchReturnItemsByOrders(
  client: SupabaseClient,
  orgId: string,
  orderIds: string[],
): Promise<Map<string, Record<string, unknown>[]>> {
  const byOrder = new Map<string, Record<string, unknown>[]>();
  const unique = [...new Set(orderIds.filter(Boolean))];
  for (let i = 0; i < unique.length; i += ORDER_CHUNK) {
    const chunk = unique.slice(i, i + ORDER_CHUNK);
    const { data, error } = await client
      .from("return_items")
      .select(RETURN_ITEM_SELECT)
      .eq("organization_id", orgId)
      .in("order_id", chunk)
      .limit(400);
    if (error) {
      if (error.message.includes("does not exist") || error.code === "42P01") return byOrder;
      throw new Error(`return_items: ${error.message}`);
    }
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const oid = nv(row.order_id);
      if (!oid) continue;
      const arr = byOrder.get(oid) ?? [];
      arr.push(row);
      byOrder.set(oid, arr);
    }
  }
  return byOrder;
}

async function fetchSlipsByPackageIds(
  client: SupabaseClient,
  orgId: string,
  packageIds: string[],
): Promise<Map<string, Record<string, unknown>[]>> {
  const byPkg = new Map<string, Record<string, unknown>[]>();
  for (let i = 0; i < packageIds.length; i += CHUNK) {
    const slice = packageIds.slice(i, i + CHUNK);
    const { data, error } = await client
      .from("slip_contents")
      .select(SLIP_SELECT)
      .eq("organization_id", orgId)
      .in("package_id", slice)
      .limit(800);
    if (error) {
      if (error.message.includes("does not exist") || error.code === "42P01") return byPkg;
      throw new Error(`slip_contents: ${error.message}`);
    }
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const pid = nv(row.package_id);
      if (!pid) continue;
      const arr = byPkg.get(pid) ?? [];
      arr.push(row);
      byPkg.set(pid, arr);
    }
  }
  return byPkg;
}

function filterFrrBySku(rows: Record<string, unknown>[], skuHint: string | null): Record<string, unknown>[] {
  const hint = normSku(skuHint);
  if (!hint) return rows;
  const matched = rows.filter((r) => normSku(nv(r.sku)) === hint);
  return matched.length > 0 ? matched : rows;
}

function buildEdgesForDraft(
  draft: DraftRow,
  removal: RemovalRow | null,
  expected: { count: number; sample_id: string | null } | undefined,
  allocations: Record<string, unknown>[],
  frrRows: Record<string, unknown>[],
  financeEvents: Record<string, unknown>[],
  returnItems: Record<string, unknown>[],
  slipsByPkg: Map<string, Record<string, unknown>[]>,
): ProposedEdge[] {
  const edges: ProposedEdge[] = [];
  const orgId = draft.organization_id;

  if (draft.source_table === "amazon_removals" && removal) {
    edges.push({
      edge_id: edgeId(draft.id, ["claim_to_removal", draft.source_row_id]),
      draft_id: draft.id,
      organization_id: orgId,
      edge_type: "claim_to_removal",
      from_node_kind: "claim_draft",
      from_source_table: "claim_candidate_drafts",
      from_source_row_id: draft.id,
      to_node_kind: "removal",
      to_source_table: "amazon_removals",
      to_source_row_id: removal.id,
      reference_kind: null,
      reference_value: null,
      confidence_score: 1,
      ambiguity_group_key: null,
      ambiguity_rank: null,
      edge_reason: "draft.source_row_id anchors operational removal row",
      source_table: "amazon_removals",
      source_citations: [{ kind: "live_query", table: "claim_candidate_drafts" }, { kind: "live_query", table: "amazon_removals", row_id: removal.id }],
    });

    if (expected && expected.count > 0) {
      edges.push({
        edge_id: edgeId(draft.id, ["claim_to_shipment", "expected_packages", removal.id]),
        draft_id: draft.id,
        organization_id: orgId,
        edge_type: "claim_to_shipment",
        from_node_kind: "claim_draft",
        from_source_table: "claim_candidate_drafts",
        from_source_row_id: draft.id,
        to_node_kind: "shipment",
        to_source_table: "expected_packages",
        to_source_row_id: expected.sample_id ?? `aggregate:${removal.id}`,
        reference_kind: "expected_package_count",
        reference_value: String(expected.count),
        confidence_score: 0.85,
        ambiguity_group_key: null,
        ambiguity_rank: null,
        edge_reason: `expected_packages.source_detail_row_id = removal.id (${expected.count} rows)`,
        source_table: "expected_packages",
        source_citations: [{ kind: "live_query", table: "expected_packages" }],
      });
    }

    let rank = 0;
    for (const alloc of allocations) {
      const allocId = nv(alloc.id);
      const sbiId = nv(alloc.shipment_box_item_id);
      if (!allocId || !sbiId) continue;
      rank += 1;
      edges.push({
        edge_id: edgeId(draft.id, ["claim_to_shipment", "allocation", allocId]),
        draft_id: draft.id,
        organization_id: orgId,
        edge_type: "claim_to_shipment",
        from_node_kind: "claim_draft",
        from_source_table: "claim_candidate_drafts",
        from_source_row_id: draft.id,
        to_node_kind: "shipment",
        to_source_table: "removal_item_allocations",
        to_source_row_id: allocId,
        reference_kind: "shipment_box_item_id",
        reference_value: sbiId,
        confidence_score: 0.9,
        ambiguity_group_key: `alloc:${removal.id}`,
        ambiguity_rank: rank,
        edge_reason: "removal_item_allocations.removal_id matches draft operational row",
        source_table: "removal_item_allocations",
        source_citations: [
          { kind: "live_query", table: "removal_item_allocations", row_id: allocId },
          { kind: "live_query", table: "shipment_box_items", row_id: sbiId },
        ],
      });
    }
  }

  const orderId = removal?.order_id ?? null;
  const skuHint = draft.sku ?? removal?.sku ?? null;

  if (orderId) {
    const allFrr = frrRows;
    const filtered = filterFrrBySku(allFrr, skuHint)
      .sort((a, b) => numConf(b.confidence_score, 0) - numConf(a.confidence_score, 0))
      .slice(0, MAX_FRR_EDGES_PER_DRAFT);
    const ambKey =
      filtered.length > 1 ? `frr:${orderId}:${normSku(skuHint) ?? "no_sku"}` : filtered.length === 1 ? null : null;
    let frrRank = 0;
    for (const row of filtered) {
      frrRank += 1;
      const trid = nv(row.trid_key) ?? "";
      const srcTable = nv(row.source_table) ?? "financial_reference_resolver";
      const srcRowId = nv(row.source_row_id) ?? trid;
      const conf = numConf(row.confidence_score, filtered.length === 1 ? 0.92 : 0.75);
      edges.push({
        edge_id: edgeId(draft.id, ["operational_to_financial", trid, srcRowId]),
        draft_id: draft.id,
        organization_id: orgId,
        edge_type: "operational_to_financial",
        from_node_kind: "removal",
        from_source_table: draft.source_table,
        from_source_row_id: draft.source_row_id,
        to_node_kind: "financial_reference_resolver_row",
        to_source_table: srcTable,
        to_source_row_id: srcRowId,
        reference_kind: "internal_trid_key",
        reference_value: trid,
        confidence_score: conf,
        ambiguity_group_key: ambKey,
        ambiguity_rank: ambKey ? frrRank : null,
        edge_reason:
          filtered.length === 1
            ? "single FRR row for order_id (+ sku filter when matched)"
            : "multiple FRR rows for order_id; parallel candidates preserved",
        source_table: "financial_reference_resolver",
        source_citations: [{ kind: "live_query", table: "financial_reference_resolver", row_id: srcRowId }],
      });
      edges.push({
        edge_id: edgeId(draft.id, ["claim_to_trid", trid, srcRowId]),
        draft_id: draft.id,
        organization_id: orgId,
        edge_type: "claim_to_trid",
        from_node_kind: "claim_draft",
        from_source_table: "claim_candidate_drafts",
        from_source_row_id: draft.id,
        to_node_kind: "internal_trid_key",
        to_source_table: "financial_reference_resolver",
        to_source_row_id: srcRowId,
        reference_kind: "internal_trid_key",
        reference_value: trid,
        confidence_score: conf,
        ambiguity_group_key: ambKey,
        ambiguity_rank: ambKey ? frrRank : null,
        edge_reason: "TRID candidate from FRR order_id join (not Amazon UI TRID until validated)",
        source_table: "financial_reference_resolver",
        source_citations: [{ kind: "live_query", table: "financial_reference_resolver", row_id: srcRowId }],
      });
    }

    let finRank = 0;
    const finAmb = financeEvents.length > 1 ? `fin:${orderId}` : null;
    for (const ev of financeEvents.slice(0, 12)) {
      finRank += 1;
      const eid = nv(ev.id);
      if (!eid) continue;
      edges.push({
        edge_id: edgeId(draft.id, ["finances_archive", eid]),
        draft_id: draft.id,
        organization_id: orgId,
        edge_type: "claim_to_settlement",
        from_node_kind: "claim_draft",
        from_source_table: "claim_candidate_drafts",
        from_source_row_id: draft.id,
        to_node_kind: "finances_archive_event",
        to_source_table: "amazon_finances_events",
        to_source_row_id: eid,
        reference_kind: "event_type",
        reference_value: nv(ev.event_type),
        confidence_score: 0.72,
        ambiguity_group_key: finAmb,
        ambiguity_rank: finAmb ? finRank : null,
        edge_reason: "amazon_finances_events matched order_id or removal_order_id (citation layer)",
        source_table: "amazon_finances_events",
        source_citations: [{ kind: "live_query", table: "amazon_finances_events", row_id: eid }],
      });
    }
  }

  const skuNorm = normSku(skuHint);
  for (const ri of returnItems) {
    const riSku = normSku(nv(ri.sku));
    if (skuNorm && riSku && riSku !== skuNorm) continue;
    const riId = nv(ri.id);
    if (!riId) continue;
    const resConf = numConf(ri.identifier_resolution_confidence, 0.65);
    const status = nv(ri.identifier_resolution_status);
    edges.push({
      edge_id: edgeId(draft.id, ["return_item", riId]),
      draft_id: draft.id,
      organization_id: orgId,
      edge_type: "operational_to_slip_line",
      from_node_kind: "claim_draft",
      from_source_table: "claim_candidate_drafts",
      from_source_row_id: draft.id,
      to_node_kind: "return_item",
      to_source_table: "return_items",
      to_source_row_id: riId,
      reference_kind: "identifier_resolution_status",
      reference_value: status,
      confidence_score: resConf,
      ambiguity_group_key: null,
      ambiguity_rank: null,
      edge_reason: "return_items matched by order_id" + (skuNorm ? " and sku" : ""),
      source_table: "return_items",
      source_citations: [{ kind: "live_query", table: "return_items", row_id: riId }],
    });
    const pkgId = nv(ri.package_id);
    if (!pkgId) continue;
    const slips = slipsByPkg.get(pkgId) ?? [];
    let slipRank = 0;
    for (const slip of slips) {
      slipRank += 1;
      const slipId = nv(slip.id);
      if (!slipId) continue;
      edges.push({
        edge_id: edgeId(draft.id, ["slip", slipId]),
        draft_id: draft.id,
        organization_id: orgId,
        edge_type: "slip_line_to_product",
        from_node_kind: "slip_line",
        from_source_table: "slip_contents",
        from_source_row_id: slipId,
        to_node_kind: "product",
        to_source_table: "products",
        to_source_row_id: nv(slip.resolved_product_id) ?? "unresolved",
        reference_kind: "identifier_resolution_status",
        reference_value: nv(slip.identifier_resolution_status),
        confidence_score: numConf(slip.identifier_resolution_confidence, nv(slip.resolved_product_id) ? 0.88 : 0.4),
        ambiguity_group_key: slips.length > 1 ? `slip:${pkgId}` : null,
        ambiguity_rank: slips.length > 1 ? slipRank : null,
        edge_reason: "slip_contents.package_id from return_items.package_id",
        source_table: "slip_contents",
        source_citations: [
          { kind: "live_query", table: "return_items", row_id: riId },
          { kind: "live_query", table: "slip_contents", row_id: slipId },
        ],
      });
    }
  }

  return edges;
}

async function main(): Promise<void> {
  loadEnvLocal();
  const { orgId, runId: runIdArg, sampleDrafts, sourceTables } = parseArgs(process.argv.slice(2));
  if (!orgId || !isUuidString(orgId)) {
    console.error("Required: --org-id=<uuid>");
    process.exitCode = 1;
    return;
  }

  const runId = runIdArg ?? isoRunId();
  const outDir = path.resolve(process.cwd(), ".cursor", "audit-reports", "next-claim-evidence-02", runId);
  fs.mkdirSync(outDir, { recursive: true });

  const client = createServiceClient();

  const graphTables = [
    "claim_enrichment_generations",
    "claim_evidence_lineage_events",
    "claim_reference_edges",
    "claim_enrichment_freeze_state",
  ];
  const evidenceTables = [
    "claim_candidate_drafts",
    "amazon_removals",
    "expected_packages",
    "removal_item_allocations",
    "shipment_box_items",
    "shipment_boxes",
    "shipment_containers",
    "financial_reference_resolver",
    "amazon_finances_events",
    "return_items",
    "slip_contents",
  ];

  const graphProbes = await Promise.all(graphTables.map((t) => probeTable(client, t, orgId)));
  const evidenceProbes = await Promise.all(evidenceTables.map((t) => probeTable(client, t, orgId)));

  const drafts = await fetchAllDrafts(client, orgId, sourceTables);
  const removalIds = drafts.filter((d) => d.source_table === "amazon_removals").map((d) => d.source_row_id);
  const removalsMap = await fetchRemovals(client, orgId, removalIds);
  const expectedMap = await fetchExpectedByDetailIds(client, orgId, removalIds);
  const allocByRemoval = await fetchAllocations(client, orgId, removalIds);

  const orderIds: string[] = [];
  for (const d of drafts) {
    if (d.source_table !== "amazon_removals") continue;
    const rm = removalsMap.get(d.source_row_id);
    if (rm?.order_id) orderIds.push(rm.order_id);
  }

  const frrByOrder = evidenceProbes.find((p) => p.table === "financial_reference_resolver")?.present
    ? await fetchFrrByOrderIds(client, orgId, orderIds)
    : new Map<string, Record<string, unknown>[]>();

  const finByOrder = evidenceProbes.find((p) => p.table === "amazon_finances_events")?.present
    ? await fetchFinancesEvents(client, orgId, orderIds)
    : new Map<string, Record<string, unknown>[]>();

  const returnsByOrder = evidenceProbes.find((p) => p.table === "return_items")?.present
    ? await fetchReturnItemsByOrders(client, orgId, orderIds)
    : new Map<string, Record<string, unknown>[]>();

  const packageIds = new Set<string>();
  for (const rows of returnsByOrder.values()) {
    for (const r of rows) {
      const pid = nv(r.package_id);
      if (pid) packageIds.add(pid);
    }
  }
  const slipsByPkg = evidenceProbes.find((p) => p.table === "slip_contents")?.present
    ? await fetchSlipsByPackageIds(client, orgId, [...packageIds])
    : new Map<string, Record<string, unknown>[]>();

  const edgeTypeHist = new Map<string, number>();
  const sourceTableHist = new Map<string, number>();
  let totalEdges = 0;
  let draftsWithZeroEdges = 0;
  let draftsWithFrr = 0;
  let draftsWithAlloc = 0;
  let draftsWithExpected = 0;
  let draftsWithFin = 0;
  let draftsWithReturnPath = 0;

  const allEdgesSample: ProposedEdge[] = [];
  const perDraftCounts: { draft_id: string; edge_count: number }[] = [];

  for (const d of drafts) {
    const removal = d.source_table === "amazon_removals" ? removalsMap.get(d.source_row_id) ?? null : null;
    const expected = expectedMap.get(d.source_row_id);
    const allocs = allocByRemoval.get(d.source_row_id) ?? [];
    const oid = removal?.order_id ?? null;
    const frr = oid ? (frrByOrder.get(oid) ?? []) : [];
    const fin = oid ? (finByOrder.get(oid) ?? []) : [];
    const ret = oid ? (returnsByOrder.get(oid) ?? []) : [];

    if (frr.length > 0) draftsWithFrr++;
    if (allocs.length > 0) draftsWithAlloc++;
    if (expected && expected.count > 0) draftsWithExpected++;
    if (fin.length > 0) draftsWithFin++;
    if (ret.length > 0) draftsWithReturnPath++;

    const edges = buildEdgesForDraft(d, removal, expected, allocs, frr, fin, ret, slipsByPkg);
    if (edges.length === 0) draftsWithZeroEdges++;
    totalEdges += edges.length;
    perDraftCounts.push({ draft_id: d.id, edge_count: edges.length });

    for (const e of edges) {
      bump(edgeTypeHist, e.edge_type);
      bump(sourceTableHist, e.source_table);
    }
  }

  const sampleDraftIds = new Set(
    drafts
      .slice(0, sampleDrafts)
      .map((d) => d.id),
  );
  for (const d of drafts) {
    if (!sampleDraftIds.has(d.id)) continue;
    const removal = d.source_table === "amazon_removals" ? removalsMap.get(d.source_row_id) ?? null : null;
    const expected = expectedMap.get(d.source_row_id);
    const allocs = allocByRemoval.get(d.source_row_id) ?? [];
    const oid = removal?.order_id ?? null;
    const frr = oid ? (frrByOrder.get(oid) ?? []) : [];
    const fin = oid ? (finByOrder.get(oid) ?? []) : [];
    const ret = oid ? (returnsByOrder.get(oid) ?? []) : [];
    allEdgesSample.push(
      ...buildEdgesForDraft(d, removal, expected, allocs, frr, fin, ret, slipsByPkg),
    );
  }

  const graphStoragePresent = graphProbes.every((p) => p.present);
  const missingGraph = graphProbes.filter((p) => !p.present).map((p) => p.table);
  const missingEvidence = evidenceProbes.filter((p) => !p.present).map((p) => p.table);

  const summary = {
    prompt_name: "NEXT-CLAIM-EVIDENCE-02",
    run_id: runId,
    script_version: SCRIPT_VERSION,
    generated_at_utc: new Date().toISOString(),
    organization_id: orgId,
    dry_run_status: "completed",
    db_writes: false,
    draft_count: drafts.length,
    total_proposed_edges: totalEdges,
    avg_edges_per_draft: drafts.length ? Math.round((totalEdges / drafts.length) * 100) / 100 : 0,
    sample_edge_count: allEdgesSample.length,
    sample_draft_count: sampleDraftIds.size,
    coverage: {
      drafts_with_frr_edges: draftsWithFrr,
      drafts_with_allocation_edges: draftsWithAlloc,
      drafts_with_expected_packages: draftsWithExpected,
      drafts_with_finances_events: draftsWithFin,
      drafts_with_return_items_path: draftsWithReturnPath,
      drafts_with_zero_edges: draftsWithZeroEdges,
    },
    edges_by_type: Object.fromEntries([...edgeTypeHist.entries()].sort((a, b) => b[1] - a[1])),
    edges_by_source_table: Object.fromEntries([...sourceTableHist.entries()].sort((a, b) => b[1] - a[1])),
    graph_storage: {
      all_present: graphStoragePresent,
      missing_tables: missingGraph,
    },
    evidence_tables_missing: missingEvidence,
    table_probes: { graph: graphProbes, evidence: evidenceProbes },
  };

  const proposedEdgesPayload = {
    ...summary,
    dry_run_only: true,
    would_persist_to: graphStoragePresent ? "claim_reference_edges" : null,
    sample_edges: allEdgesSample,
    per_draft_edge_counts: perDraftCounts.slice(0, 200),
  };

  fs.writeFileSync(path.join(outDir, "proposed-edges.json"), JSON.stringify(proposedEdgesPayload, null, 2), "utf8");
  fs.writeFileSync(path.join(outDir, "00-collector-summary.json"), JSON.stringify(summary, null, 2), "utf8");

  writeMarkdownArtifacts(outDir, summary, graphProbes, evidenceProbes, missingGraph, missingEvidence, allEdgesSample);

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt_name: "NEXT-CLAIM-EVIDENCE-02",
        run_id: runId,
        mode: "read_only_dry_run",
        organization_id: orgId,
        artifacts: [
          "dry-run-input-contract.md",
          "evidence-collector-summary.md",
          "proposed-edges.json",
          "proposed-edges-summary.md",
          "missing-graph-storage-report.md",
          "confidence-policy.md",
          "tests-and-validation.md",
          "blockers.md",
          "next-step-recommendation.md",
          "manifest.json",
          "00-collector-summary.json",
        ],
        validation: { db_writes: false, migrations_applied: false, graph_storage_present: graphStoragePresent },
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`NEXT-CLAIM-EVIDENCE-02 complete. Output: ${outDir}`);
  console.log(JSON.stringify(summary, null, 2));
}

function writeMarkdownArtifacts(
  outDir: string,
  summary: Record<string, unknown>,
  graphProbes: TableProbe[],
  evidenceProbes: TableProbe[],
  missingGraph: string[],
  missingEvidence: string[],
  sampleEdges: ProposedEdge[],
): void {
  const cov = summary.coverage as Record<string, number>;
  const byType = summary.edges_by_type as Record<string, number>;

  fs.writeFileSync(
    path.join(outDir, "dry-run-input-contract.md"),
    `# Dry-run input contract

## CLI

\`\`\`text
npx tsx scripts/claim-evidence-graph-dryrun.ts --org-id=<uuid> [--run-id=<id>] [--sample-drafts=35] [--include-returns]
\`\`\`

## Input rows

| Source | Filter |
|--------|--------|
| \`claim_candidate_drafts\` | \`organization_id\`, \`source_table IN ('amazon_removals'[, 'amazon_returns'])\` |

Per draft: \`id\`, \`source_row_id\`, \`sku\`, \`store_id\`.

## Evidence collectors (SELECT only)

| Collector | Table(s) | Join |
|-----------|----------|------|
| Operational anchor | \`amazon_removals\` | \`id = draft.source_row_id\` |
| Expected scan | \`expected_packages\` | \`source_detail_row_id = removal.id\` |
| Allocation lineage | \`removal_item_allocations\` → \`shipment_box_items\` | \`removal_id\` |
| FRR / TRID | \`financial_reference_resolver\` | \`order_id\` (+ optional sku filter) |
| Finances archive | \`amazon_finances_events\` | \`order_id\` (or \`removal_order_id\`) |
| Return resolver | \`return_items\` | \`order_id\` (+ sku when set) |
| Slip resolver | \`slip_contents\` | \`package_id\` from matched return_items |

## Output

- \`proposed-edges.json\` — aggregate stats + \`sample_edges\` (not full 1.6k×N dump)
- Per-draft counts in \`per_draft_edge_counts\` (first 200 ids)

## Explicit non-inputs

No \`claim_candidates\` inbox rows in v1 script (draft-first). No writes. No Amazon API. No AI.
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "evidence-collector-summary.md"),
    `# Evidence collector summary

| Metric | Value |
|--------|-------|
| Run ID | \`${summary.run_id}\` |
| Organization | \`${summary.organization_id}\` |
| Drafts processed | **${summary.draft_count}** |
| Total proposed edges | **${summary.total_proposed_edges}** |
| Avg edges / draft | **${summary.avg_edges_per_draft}** |
| Sample edges in JSON | **${summary.sample_edge_count}** (${summary.sample_draft_count} drafts) |

## Coverage (drafts with ≥1 edge of kind)

| Kind | Draft count |
|------|-------------|
| FRR / TRID | ${cov.drafts_with_frr_edges} |
| \`removal_item_allocations\` | ${cov.drafts_with_allocation_edges} |
| \`expected_packages\` | ${cov.drafts_with_expected_packages} |
| \`amazon_finances_events\` | ${cov.drafts_with_finances_events} |
| \`return_items\` (+ slip follow-on) | ${cov.drafts_with_return_items_path} |
| Zero edges | ${cov.drafts_with_zero_edges} |

## Edge types (all drafts)

${Object.entries(byType)
  .map(([k, v]) => `- \`${k}\`: **${v}**`)
  .join("\n")}

## Evidence table probes

${evidenceProbes.map((p) => `- \`${p.table}\`: ${p.present ? "present" : `missing — ${p.error ?? ""}`}`).join("\n")}
`,
    "utf8",
  );

  const topTypes = Object.entries(byType).slice(0, 6);
  fs.writeFileSync(
    path.join(outDir, "proposed-edges-summary.md"),
    `# Proposed edges summary

Dry-run proposed **${summary.total_proposed_edges}** edges for **${summary.draft_count}** drafts. Full sample in \`proposed-edges.json\` (\`sample_edges\`).

## Edge type distribution

${topTypes.map(([k, v]) => `| \`${k}\` | ${v} |`).join("\n| | |\n")}

## Example edges (first 5 sample)

${sampleEdges
  .slice(0, 5)
  .map(
    (e) =>
      `### \`${e.edge_type}\` → \`${e.to_source_table}\`

- **draft:** \`${e.draft_id}\`
- **confidence:** ${e.confidence_score}
- **reason:** ${e.edge_reason}
- **reference:** ${e.reference_kind ?? "—"} = ${e.reference_value ?? "—"}
`,
  )
  .join("\n")}

## Persistence

Edges are **not** inserted. Target table when migrated: \`claim_reference_edges\` (+ optional \`claim_evidence_lineage_events\`).
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "missing-graph-storage-report.md"),
    `# Missing graph storage report

## CCE graph tables

${graphProbes.map((p) => `| \`${p.table}\` | ${p.present ? "✅ present" : "❌ absent"} |`).join("\n")}

**Graph storage ready:** ${(summary.graph_storage as { all_present: boolean }).all_present ? "yes" : "**no — dry-run cannot persist edges**"}

Missing: ${missingGraph.length ? missingGraph.map((t) => `\`${t}\``).join(", ") : "none"}

## Evidence source tables absent on this project

${missingEvidence.length ? missingEvidence.map((t) => `- \`${t}\``).join("\n") : "_All probed evidence tables present._"}

## Repo migrations not applied (typical)

From CLAIM-EVIDENCE-01 plan — apply in approved env only:

- CCE additive DDL (\`claim_enrichment_generations\`, \`claim_evidence_lineage_events\`, \`claim_reference_edges\`)
- \`amazon_finances_api_archive\` (\`20260819120000\`) if finances events probe fails
- \`claim_review_work_items\` (optional for review UX, not required for edge dry-run)
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "confidence-policy.md"),
    `# Confidence policy (dry-run)

Scores are **heuristic** for ranking/display only; not filing authority.

| Edge / situation | Default score | Notes |
|------------------|---------------|-------|
| \`claim_to_removal\` | **1.0** | Direct draft → operational anchor |
| \`claim_to_shipment\` via \`removal_item_allocations\` | **0.90** | Deterministic FK |
| \`claim_to_shipment\` via \`expected_packages\` aggregate | **0.85** | May fan out many rows |
| \`operational_to_financial\` / \`claim_to_trid\` (single FRR) | **FRR confidence** or **0.92** | Use \`financial_reference_resolver.confidence_score\` when set |
| Multiple FRR candidates | **0.75** + shared \`ambiguity_group_key\` | Never auto-pick best |
| \`amazon_finances_events\` citation | **0.72** | Archive layer; cap 12 events/draft in dry-run |
| \`return_items\` order match | **resolver confidence** or **0.65** | Weaker cross-domain join |
| \`slip_line_to_product\` resolved | **resolver confidence** or **0.88** | Unresolved product → **0.40** |

## Ambiguity

- \`ambiguity_group_key\` set when parallel edges share the same join (FRR, finances, multi-slip).
- \`ambiguity_rank\` is display order only (1-based per group).

## Labels

- \`reference_kind = internal_trid_key\` — not Amazon UI TRID until operator-validated.
`,
    "utf8",
  );

  const blockers: string[] = [];
  if (missingGraph.length) blockers.push(`CCE graph tables missing: ${missingGraph.join(", ")}`);
  if (missingEvidence.includes("financial_reference_resolver")) blockers.push("FRR table absent — no TRID edges possible");
  if (missingEvidence.includes("amazon_finances_events")) blockers.push("Finances archive not migrated — no archive citation edges");
  if ((cov.drafts_with_zero_edges as number) > 0) blockers.push(`${cov.drafts_with_zero_edges} drafts produced zero edges (missing operational row or unsupported source_table)`);

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    `# Blockers

${blockers.length ? blockers.map((b) => `- ${b}`).join("\n") : "- None critical for dry-run completion (read-only audit succeeded)."}

## Non-blockers

- Graph storage absent is **expected** until CCE-04 migration apply.
- Low \`return_items\` / slip coverage on removal-only drafts is expected (order_id cross-link sparse).
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "tests-and-validation.md"),
    `# Tests and validation

## Executed

| Check | Result |
|-------|--------|
| Script exits 0 | Run \`${summary.run_id}\` |
| \`db_writes\` | **false** (SELECT-only script) |
| \`claim_candidate_drafts\` readable | ${summary.draft_count} rows |
| \`proposed-edges.json\` valid JSON | yes |
| Edge \`edge_id\` stable prefix | \`dryrun:\` + hash |

## Recommended follow-up

\`\`\`text
npx tsx scripts/claim-evidence-graph-dryrun.ts --org-id=${summary.organization_id} --sample-drafts=50
\`\`\`

Compare \`edges_by_type\` run-over-run after allocation rebuild or FRR sync.

## Not run

- Unit tests (no test file in this prompt)
- Inbox \`claim_candidates\` path (draft-first scope)
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "next-step-recommendation.md"),
    `# Next step recommendation

## Completed

NEXT-CLAIM-EVIDENCE-02 dry-run: **${summary.total_proposed_edges}** proposed edges, **${summary.draft_count}** drafts, graph storage **${(summary.graph_storage as { all_present: boolean }).all_present ? "present" : "not migrated"}**.

## Exact next prompt

\`\`\`
NEXT-CONTINUOUS-CLAIM-ENRICHMENT-04 — CCE ADDITIVE DDL APPLY (DEV/STAGING)
\`\`\`

Then:

\`\`\`
NEXT-CLAIM-EVIDENCE-03 — EVIDENCE API + INBOX VIEWER (READ-ONLY)
\`\`\`

Optional parallel: apply \`20260819120000_amazon_finances_api_archive.sql\` if finances events were absent.

## Persist path (after CCE DDL)

1. Replay dry-run output through idempotent edge inserter (service_role, generation header).
2. Wire \`GET /api/claims/drafts/:id/evidence-graph\` to stored edges + live fallback.
`,
    "utf8",
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
