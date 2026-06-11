/**
 * Product linkage health metrics — read-only census for operator dashboards.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  type DuplicateRiskSummary,
  RESOLUTION_ORDER_OPERATIONAL,
  RESOLUTION_ORDER_SCANNER,
  summarizeDuplicateRisks,
} from "./product-linkage-resolution-policy";

export type OperationalTableLinkageRow = {
  table: string;
  path: string;
  total: number;
  resolved: number;
  unresolved: number;
  ambiguous: number;
  linkage_percent: number;
};

export type LinkageHealthSnapshot = {
  organization_id: string;
  generated_at: string;
  resolution_order: {
    scanner: readonly string[];
    operational_import: readonly string[];
  };
  spine: {
    products: number;
    product_identifier_map: number;
  };
  operational_tables: OperationalTableLinkageRow[];
  unresolved_count: number;
  ambiguous_count: number;
  duplicate_risks: DuplicateRiskSummary;
  linkage_health: {
    overall_percent: number;
    critical_paths_percent: number;
    grade: "healthy" | "degraded" | "critical";
    safe_for_product_story: "yes" | "conditional" | "no";
  };
};

type TableSpec = {
  table: string;
  path: string;
  activeFilter?: string;
  resolvedCol?: string;
  statusCol?: string;
};

const OPERATIONAL_TABLE_SPECS: TableSpec[] = [
  { table: "return_items", path: "scan", activeFilter: "deleted_at.is.null", resolvedCol: "resolved_product_id" },
  { table: "expected_packages", path: "expected", resolvedCol: "resolved_product_id" },
  { table: "slip_contents", path: "scan", resolvedCol: "resolved_product_id" },
  { table: "claim_candidates", path: "claim", resolvedCol: "resolved_product_id" },
  { table: "claim_candidate_drafts", path: "claim", resolvedCol: "resolved_product_id" },
  { table: "amazon_removals", path: "removal", resolvedCol: "resolved_product_id" },
  { table: "amazon_removal_shipments", path: "removal", resolvedCol: "resolved_product_id" },
  { table: "shipment_box_items", path: "shipment", resolvedCol: "resolved_product_id", statusCol: "identifier_resolution_status" },
];

async function tableExists(client: SupabaseClient, name: string): Promise<boolean> {
  const { error } = await client.from(name).select("id", { head: true, count: "exact" }).limit(0);
  return !error;
}

async function countLinkageForTable(
  client: SupabaseClient,
  orgId: string,
  spec: TableSpec,
): Promise<OperationalTableLinkageRow | null> {
  if (!(await tableExists(client, spec.table))) return null;

  const resolvedCol = spec.resolvedCol ?? "resolved_product_id";
  const statusCol = spec.statusCol ?? "identifier_resolution_status";

  let q = client.from(spec.table).select("*", { count: "exact", head: true }).eq("organization_id", orgId);
  if (spec.activeFilter === "deleted_at.is.null") {
    q = q.is("deleted_at", null);
  }
  const totalRes = await q;
  if (totalRes.error) return null;
  const total = totalRes.count ?? 0;

  let resolvedQ = client
    .from(spec.table)
    .select("*", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .not(resolvedCol, "is", null);
  if (spec.activeFilter === "deleted_at.is.null") resolvedQ = resolvedQ.is("deleted_at", null);
  const resolvedRes = await resolvedQ;
  if (resolvedRes.error) {
    return {
      table: spec.table,
      path: spec.path,
      total,
      resolved: 0,
      unresolved: total,
      ambiguous: 0,
      linkage_percent: 0,
    };
  }
  const resolved = resolvedRes.count ?? 0;

  let ambiguous = 0;
  if (await tableExists(client, spec.table)) {
    const ambQ = client
      .from(spec.table)
      .select("*", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq(statusCol, "ambiguous");
    const ambRes = await ambQ;
    ambiguous = ambRes.count ?? 0;
  }

  const unresolved = Math.max(0, total - resolved);
  const linkage_percent = total === 0 ? 100 : Math.round((resolved / total) * 1000) / 10;

  return {
    table: spec.table,
    path: spec.path,
    total,
    resolved,
    unresolved,
    ambiguous,
    linkage_percent,
  };
}

async function fetchDuplicateConflictCounts(
  client: SupabaseClient,
  orgId: string,
): Promise<DuplicateRiskSummary> {
  const fnskuMap = new Map<string, Set<string>>();
  const asinMap = new Map<string, Set<string>>();
  const upcMap = new Map<string, Set<string>>();
  const skuMap = new Map<string, Set<string>>();

  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const { data: mapRows, error } = await client
      .from("product_identifier_map")
      .select("fnsku, asin, upc_code, seller_sku, product_id")
      .eq("organization_id", orgId)
      .is("deleted_at", null)
      .range(from, from + pageSize - 1);
    if (error || !mapRows?.length) break;

    for (const row of mapRows as Record<string, unknown>[]) {
      const pid = String(row.product_id ?? "").trim();
      if (!pid) continue;
      const f = String(row.fnsku ?? "").trim().toUpperCase();
      const a = String(row.asin ?? "").trim().toUpperCase();
      const u = String(row.upc_code ?? "").trim();
      const s = String(row.seller_sku ?? "").trim();
      if (f) {
        const set = fnskuMap.get(f) ?? new Set();
        set.add(pid);
        fnskuMap.set(f, set);
      }
      if (a) {
        const set = asinMap.get(a) ?? new Set();
        set.add(pid);
        asinMap.set(a, set);
      }
      if (u) {
        const set = upcMap.get(u) ?? new Set();
        set.add(pid);
        upcMap.set(u, set);
      }
      if (s) {
        const set = skuMap.get(s) ?? new Set();
        set.add(pid);
        skuMap.set(s, set);
      }
    }

    if (mapRows.length < pageSize) break;
    from += pageSize;
  }

  const conflictGroups = (m: Map<string, Set<string>>) =>
    [...m.values()].filter((s) => s.size > 1).length;

  return summarizeDuplicateRisks({
    fnsku: conflictGroups(fnskuMap),
    asin: conflictGroups(asinMap),
    upc: conflictGroups(upcMap),
    sku: conflictGroups(skuMap),
  });
}

function gradeLinkage(overall: number, critical: number): LinkageHealthSnapshot["linkage_health"]["grade"] {
  if (overall >= 90 && critical >= 85) return "healthy";
  if (overall >= 70 && critical >= 60) return "degraded";
  return "critical";
}

function safeForProductStory(
  grade: LinkageHealthSnapshot["linkage_health"]["grade"],
  duplicateRisks: DuplicateRiskSummary,
): LinkageHealthSnapshot["linkage_health"]["safe_for_product_story"] {
  if (grade === "healthy" && duplicateRisks.fnsku_conflict_groups === 0) return "yes";
  if (grade === "critical") return "no";
  return "conditional";
}

/** Fetch linkage health snapshot for an organization (read-only). */
export async function fetchLinkageHealthSnapshot(
  client: SupabaseClient,
  organizationId: string,
): Promise<LinkageHealthSnapshot> {
  const operational_tables: OperationalTableLinkageRow[] = [];
  for (const spec of OPERATIONAL_TABLE_SPECS) {
    const row = await countLinkageForTable(client, organizationId, spec);
    if (row) operational_tables.push(row);
  }

  const { count: productsCount } = await client
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .is("deleted_at", null);

  const { count: mapCount } = await client
    .from("product_identifier_map")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .is("deleted_at", null);

  const duplicate_risks = await fetchDuplicateConflictCounts(client, organizationId);

  const unresolved_count = operational_tables.reduce((s, r) => s + r.unresolved, 0);
  const ambiguous_count = operational_tables.reduce((s, r) => s + r.ambiguous, 0);
  const totalOps = operational_tables.reduce((s, r) => s + r.total, 0);
  const resolvedOps = operational_tables.reduce((s, r) => s + r.resolved, 0);
  const overall_percent =
    totalOps === 0 ? 100 : Math.round((resolvedOps / totalOps) * 1000) / 10;

  const criticalPaths = operational_tables.filter((r) =>
    ["scan", "expected", "claim"].includes(r.path),
  );
  const criticalTotal = criticalPaths.reduce((s, r) => s + r.total, 0);
  const criticalResolved = criticalPaths.reduce((s, r) => s + r.resolved, 0);
  const critical_paths_percent =
    criticalTotal === 0 ? 100 : Math.round((criticalResolved / criticalTotal) * 1000) / 10;

  const grade = gradeLinkage(overall_percent, critical_paths_percent);

  return {
    organization_id: organizationId,
    generated_at: new Date().toISOString(),
    resolution_order: {
      scanner: RESOLUTION_ORDER_SCANNER,
      operational_import: RESOLUTION_ORDER_OPERATIONAL,
    },
    spine: {
      products: productsCount ?? 0,
      product_identifier_map: mapCount ?? 0,
    },
    operational_tables,
    unresolved_count,
    ambiguous_count,
    duplicate_risks,
    linkage_health: {
      overall_percent,
      critical_paths_percent,
      grade,
      safe_for_product_story: safeForProductStory(grade, duplicate_risks),
    },
  };
}
