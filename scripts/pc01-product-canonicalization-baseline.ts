/**
 * PC01 — PRODUCT CANONICALIZATION BASELINE (read-only, staging)
 *
 *   npx tsx scripts/pc01-product-canonicalization-baseline.ts
 *   npx tsx scripts/pc01-product-canonicalization-baseline.ts --run-id=20260522T230000Z
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const OUT_BASE = ".cursor/audit-reports/pc01-product-canonicalization-baseline";

type Category =
  | "catalog-spine"
  | "item-level"
  | "package-pallet-aggregate"
  | "report-source"
  | "claim"
  | "view-read-model";

type PersistMode =
  | "persist-resolved"
  | "persist-legacy-product-id"
  | "read-layer-only"
  | "aggregate-indirect"
  | "n/a";

type NextAction =
  | "map-only"
  | "trusted_product_promotion"
  | "sp_api_evidence"
  | "manual_review"
  | "no_product_link_needed";

type TableSpec = {
  name: string;
  category: Category;
  owner: string;
  persist_mode: PersistMode;
  product_col?: string;
  resolved_col?: string;
  id_cols: string[];
  active_filter?: { col: string; op: "is" | "eq"; val: unknown }[];
  notes: string;
};

type CensusRow = {
  name: string;
  category: Category;
  owner: string;
  persist_mode: PersistMode;
  total_rows: number | null;
  rows_with_product_link: number | null;
  rows_with_identifiers_no_product_id: number | null;
  read_layer_resolved: number | null;
  unresolved_rows: number | null;
  ambiguous_rows: number | null;
  safest_next_action: NextAction;
  query_errors: string[];
  notes: string;
};

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function sbClient(): SupabaseClient {
  loadEnvLocalIntoProcess();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  if (refFromSupabaseUrl(url) !== STAGING_REF) {
    throw new Error(`Ref guard failed: expected staging ${STAGING_REF}`);
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

async function countHead(
  sb: SupabaseClient,
  table: string,
  filters: { col: string; op: "eq" | "is" | "not"; val: unknown }[] = [],
): Promise<{ count: number | null; error: string | null }> {
  try {
    let q = sb.from(table).select("*", { count: "exact", head: true });
    for (const f of filters) {
      if (f.op === "eq") q = q.eq(f.col, f.val as string);
      else if (f.op === "is") q = q.is(f.col, f.val);
      else q = q.not(f.col, "is", null);
    }
    const { count, error } = await q;
    if (error) return { count: null, error: error.message };
    return { count: count ?? 0, error: null };
  } catch (e) {
    return { count: null, error: e instanceof Error ? e.message : String(e) };
  }
}

const TABLE_SPECS: TableSpec[] = [
  {
    name: "products",
    category: "catalog-spine",
    owner: "PIM/catalog",
    persist_mode: "n/a",
    id_cols: [],
    notes: "Canonical product spine.",
  },
  {
    name: "product_identifier_map",
    category: "catalog-spine",
    owner: "Governed map executes",
    persist_mode: "n/a",
    product_col: "product_id",
    id_cols: ["seller_sku", "msku", "asin", "fnsku", "upc_code"],
    active_filter: [{ col: "deleted_at", op: "is", val: null }],
    notes: "Active map rows only (deleted_at IS NULL).",
  },
  {
    name: "return_items",
    category: "item-level",
    owner: "Returns scanner",
    persist_mode: "persist-resolved",
    product_col: "product_id",
    resolved_col: "resolved_product_id",
    id_cols: ["sku", "fnsku", "asin", "product_identifier"],
    active_filter: [{ col: "deleted_at", op: "is", val: null }],
    notes: "Canonical scanned item lines.",
  },
  {
    name: "expected_packages",
    category: "item-level",
    owner: "Amazon expected import",
    persist_mode: "read-layer-only",
    resolved_col: "resolved_product_id",
    id_cols: ["sku", "fnsku"],
    notes: "Read resolves via map; no bulk persist.",
  },
  {
    name: "slip_contents",
    category: "item-level",
    owner: "Packing-slip import",
    persist_mode: "persist-resolved",
    product_col: "product_id",
    resolved_col: "resolved_product_id",
    id_cols: ["sku", "fnsku", "asin"],
    notes: "Small OCR/import cohort.",
  },
  {
    name: "packages",
    category: "package-pallet-aggregate",
    owner: "Returns hierarchy",
    persist_mode: "aggregate-indirect",
    id_cols: [],
    notes: "Product via child return_items.",
  },
  {
    name: "pallets",
    category: "package-pallet-aggregate",
    owner: "Returns hierarchy",
    persist_mode: "aggregate-indirect",
    id_cols: [],
    notes: "Aggregate only.",
  },
  {
    name: "shipment_boxes",
    category: "package-pallet-aggregate",
    owner: "Shipment scan tree",
    persist_mode: "aggregate-indirect",
    id_cols: [],
    notes: "Box parent; linkage via box_items.",
  },
  {
    name: "shipment_box_items",
    category: "item-level",
    owner: "Shipment scan allocation",
    persist_mode: "read-layer-only",
    id_cols: ["sku", "fnsku"],
    notes: "No resolved_product_id column; resolve at read/submit.",
  },
  {
    name: "shipment_containers",
    category: "package-pallet-aggregate",
    owner: "Shipment tracking",
    persist_mode: "aggregate-indirect",
    id_cols: [],
    notes: "Tracking-level parent only.",
  },
  {
    name: "amazon_amazon_fulfilled_inventory",
    category: "report-source",
    owner: "AFI import",
    persist_mode: "persist-resolved",
    product_col: "product_id",
    resolved_col: "resolved_product_id",
    id_cols: ["seller_sku", "fulfillment_channel_sku", "asin"],
    notes: "Primary Amazon inventory report spine.",
  },
  {
    name: "amazon_fba_inventory",
    category: "report-source",
    owner: "FBA inventory import",
    persist_mode: "persist-resolved",
    product_col: "product_id",
    resolved_col: "resolved_product_id",
    id_cols: ["sku", "fnsku", "asin"],
    notes: "Trusted product_name for E2.",
  },
  {
    name: "amazon_manage_fba_inventory",
    category: "report-source",
    owner: "Manage FBA import",
    persist_mode: "persist-resolved",
    product_col: "product_id",
    resolved_col: "resolved_product_id",
    id_cols: ["sku", "fnsku", "asin"],
    notes: "Trusted product_name for E2.",
  },
  {
    name: "amazon_returns",
    category: "report-source",
    owner: "Amazon returns report",
    persist_mode: "persist-resolved",
    product_col: "product_id",
    resolved_col: "resolved_product_id",
    id_cols: ["sku", "fnsku", "asin"],
    notes: "Claim source candidate.",
  },
  {
    name: "amazon_settlements",
    category: "report-source",
    owner: "Settlement report",
    persist_mode: "read-layer-only",
    resolved_col: "resolved_product_id",
    id_cols: ["sku", "asin"],
    notes: "Financial lines; product creation forbidden.",
  },
  {
    name: "claim_candidates",
    category: "claim",
    owner: "Claim inbox",
    persist_mode: "persist-resolved",
    product_col: "product_id",
    resolved_col: "resolved_product_id",
    id_cols: ["sku", "fnsku", "asin"],
    notes: "Legacy claim queue.",
  },
  {
    name: "claim_candidate_drafts",
    category: "claim",
    owner: "V2 claim generator",
    persist_mode: "persist-resolved",
    product_col: "product_id",
    resolved_col: "resolved_product_id",
    id_cols: ["sku", "fnsku", "asin"],
    notes: "Promotes to claim_candidates.",
  },
  {
    name: "v_scanned_items_counted",
    category: "view-read-model",
    owner: "Neda inventory (scanned)",
    persist_mode: "read-layer-only",
    product_col: "product_id",
    resolved_col: "resolved_product_id",
    id_cols: ["sku", "fnsku", "asin"],
    notes: "Scanned aggregate view with product columns.",
  },
  {
    name: "v_inventory_item_status",
    category: "view-read-model",
    owner: "Neda expected/scanned compare",
    persist_mode: "read-layer-only",
    resolved_col: "resolved_product_id",
    id_cols: ["sku", "fnsku", "asin"],
    notes: "Item-level compare with product_comparison.",
  },
  {
    name: "v_inventory_status",
    category: "view-read-model",
    owner: "Neda package aggregate",
    persist_mode: "aggregate-indirect",
    id_cols: [],
    notes: "Package-level counts; product-agnostic by design.",
  },
];

async function censusTable(sb: SupabaseClient, spec: TableSpec): Promise<CensusRow> {
  const errors: string[] = [];
  const filters = spec.active_filter ?? [];

  const total = await countHead(sb, spec.name, filters);
  if (total.error) errors.push(`total: ${total.error}`);

  let productN: number | null = null;
  if (spec.product_col) {
    const pn = await countHead(sb, spec.name, [...filters, { col: spec.product_col, op: "not", val: null }]);
    if (pn.error) errors.push(`${spec.product_col}: ${pn.error}`);
    else productN = pn.count;
  }

  let resolvedN: number | null = null;
  if (spec.resolved_col) {
    const rn = await countHead(sb, spec.name, [...filters, { col: spec.resolved_col, op: "not", val: null }]);
    if (rn.error) errors.push(`${spec.resolved_col}: ${rn.error}`);
    else resolvedN = rn.count;
  }

  let idAny: number | null = null;
  if (spec.id_cols.length) {
    const perCol: number[] = [];
    for (const col of spec.id_cols) {
      const c = await countHead(sb, spec.name, [...filters, { col, op: "not", val: null }]);
      if (c.error) errors.push(`${col}: ${c.error}`);
      else if (c.count != null) perCol.push(c.count);
    }
    if (perCol.length) idAny = Math.max(...perCol);
  }

  const link = Math.max(resolvedN ?? 0, productN ?? 0);
  const idOnly = spec.id_cols.length ? Math.max(0, (idAny ?? 0) - link) : null;

  if (spec.name === "products") {
    return {
      name: spec.name,
      category: spec.category,
      owner: spec.owner,
      persist_mode: spec.persist_mode,
      total_rows: total.count,
      rows_with_product_link: total.count,
      rows_with_identifiers_no_product_id: 0,
      read_layer_resolved: total.count,
      unresolved_rows: 0,
      ambiguous_rows: null,
      safest_next_action: "no_product_link_needed",
      query_errors: errors,
      notes: spec.notes,
    };
  }

  return {
    name: spec.name,
    category: spec.category,
    owner: spec.owner,
    persist_mode: spec.persist_mode,
    total_rows: total.count,
    rows_with_product_link: link || null,
    rows_with_identifiers_no_product_id: idOnly,
    read_layer_resolved: null,
    unresolved_rows: null,
    ambiguous_rows: null,
    safest_next_action: "manual_review",
    query_errors: errors,
    notes: spec.notes,
  };
}

async function pgReadLayer(
  table: "return_items" | "expected_packages" | "slip_contents",
): Promise<{ read_layer_resolved: number; unresolved: number; ambiguous: number } | null> {
  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  if (!dbUrl || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) return null;

  const client = new pg.Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
  });

  const sqlByTable: Record<string, string> = {
    return_items: `
      WITH base AS (
        SELECT id, organization_id, store_id,
          NULLIF(TRIM(sku), '') AS sku, NULLIF(TRIM(fnsku), '') AS fnsku,
          NULLIF(TRIM(asin), '') AS asin, resolved_product_id
        FROM public.return_items WHERE deleted_at IS NULL
      ),
      map_fnsku AS (
        SELECT b.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
        FROM base b
        LEFT JOIN public.product_identifier_map m
          ON m.organization_id=b.organization_id AND m.store_id=b.store_id
         AND m.deleted_at IS NULL AND b.fnsku IS NOT NULL AND m.fnsku=b.fnsku
        GROUP BY b.id
      ),
      map_sku AS (
        SELECT b.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
        FROM base b
        LEFT JOIN public.product_identifier_map m
          ON m.organization_id=b.organization_id AND m.store_id=b.store_id
         AND m.deleted_at IS NULL AND b.sku IS NOT NULL AND (m.seller_sku=b.sku OR m.msku=b.sku)
        GROUP BY b.id
      ),
      classified AS (
        SELECT b.id,
          CASE
            WHEN b.resolved_product_id IS NOT NULL THEN 'direct'
            WHEN COALESCE(mf.c,0)=1 THEN 'map'
            WHEN COALESCE(ms.c,0)=1 THEN 'map'
            WHEN COALESCE(mf.c,0)>1 OR COALESCE(ms.c,0)>1 THEN 'ambiguous'
            WHEN b.sku IS NULL AND b.fnsku IS NULL AND b.asin IS NULL THEN 'no_identifier'
            ELSE 'unresolved'
          END AS bucket
        FROM base b
        LEFT JOIN map_fnsku mf ON mf.id=b.id
        LEFT JOIN map_sku ms ON ms.id=b.id
      )
      SELECT
        COUNT(*) FILTER (WHERE bucket IN ('direct','map'))::int AS read_layer_resolved,
        COUNT(*) FILTER (WHERE bucket='unresolved')::int AS unresolved,
        COUNT(*) FILTER (WHERE bucket='ambiguous')::int AS ambiguous
      FROM classified`,
    expected_packages: `
      WITH ep AS (
        SELECT id, organization_id, store_id, NULLIF(TRIM(sku), '') AS sku,
          NULLIF(TRIM(fnsku), '') AS fnsku, resolved_product_id
        FROM public.expected_packages
      ),
      map_fnsku AS (
        SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
        FROM ep
        LEFT JOIN public.product_identifier_map m
          ON m.organization_id=ep.organization_id AND m.store_id=ep.store_id
         AND m.deleted_at IS NULL AND ep.fnsku IS NOT NULL AND m.fnsku=ep.fnsku
        GROUP BY ep.id
      ),
      map_sku AS (
        SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
        FROM ep
        LEFT JOIN public.product_identifier_map m
          ON m.organization_id=ep.organization_id AND m.store_id=ep.store_id
         AND m.deleted_at IS NULL AND ep.sku IS NOT NULL AND (m.seller_sku=ep.sku OR m.msku=ep.sku)
        GROUP BY ep.id
      ),
      classified AS (
        SELECT ep.id,
          CASE
            WHEN ep.resolved_product_id IS NOT NULL THEN 'direct'
            WHEN COALESCE(mf.c,0)=1 THEN 'map'
            WHEN COALESCE(ms.c,0)=1 THEN 'map'
            WHEN COALESCE(mf.c,0)>1 OR COALESCE(ms.c,0)>1 THEN 'ambiguous'
            ELSE 'unresolved'
          END AS bucket
        FROM ep
        LEFT JOIN map_fnsku mf ON mf.id=ep.id
        LEFT JOIN map_sku ms ON ms.id=ep.id
      )
      SELECT
        COUNT(*) FILTER (WHERE bucket IN ('direct','map'))::int AS read_layer_resolved,
        COUNT(*) FILTER (WHERE bucket='unresolved')::int AS unresolved,
        COUNT(*) FILTER (WHERE bucket='ambiguous')::int AS ambiguous
      FROM classified`,
    slip_contents: `
      WITH base AS (
        SELECT id, organization_id, store_id,
          NULLIF(TRIM(sku), '') AS sku, NULLIF(TRIM(fnsku), '') AS fnsku,
          NULLIF(TRIM(asin), '') AS asin, resolved_product_id, product_id
        FROM public.slip_contents
      ),
      map_fnsku AS (
        SELECT b.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
        FROM base b
        LEFT JOIN public.product_identifier_map m
          ON m.organization_id=b.organization_id AND m.store_id=b.store_id
         AND m.deleted_at IS NULL AND b.fnsku IS NOT NULL AND m.fnsku=b.fnsku
        GROUP BY b.id
      ),
      map_sku AS (
        SELECT b.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
        FROM base b
        LEFT JOIN public.product_identifier_map m
          ON m.organization_id=b.organization_id AND m.store_id=b.store_id
         AND m.deleted_at IS NULL AND b.sku IS NOT NULL AND (m.seller_sku=b.sku OR m.msku=b.sku)
        GROUP BY b.id
      ),
      classified AS (
        SELECT b.id,
          CASE
            WHEN b.resolved_product_id IS NOT NULL THEN 'direct'
            WHEN b.product_id IS NOT NULL THEN 'legacy'
            WHEN COALESCE(mf.c,0)=1 OR COALESCE(ms.c,0)=1 THEN 'map'
            WHEN COALESCE(mf.c,0)>1 OR COALESCE(ms.c,0)>1 THEN 'ambiguous'
            WHEN b.sku IS NULL AND b.fnsku IS NULL AND b.asin IS NULL THEN 'no_identifier'
            ELSE 'unresolved'
          END AS bucket
        FROM base b
        LEFT JOIN map_fnsku mf ON mf.id=b.id
        LEFT JOIN map_sku ms ON ms.id=b.id
      )
      SELECT
        COUNT(*) FILTER (WHERE bucket IN ('direct','legacy','map'))::int AS read_layer_resolved,
        COUNT(*) FILTER (WHERE bucket='unresolved')::int AS unresolved,
        COUNT(*) FILTER (WHERE bucket='ambiguous')::int AS ambiguous
      FROM classified`,
  };

  try {
    await client.connect();
    await client.query("SET statement_timeout = '90s'");
    const r = await client.query(sqlByTable[table]);
    await client.end();
    const row = r.rows[0] as Record<string, number>;
    return {
      read_layer_resolved: Number(row.read_layer_resolved ?? 0),
      unresolved: Number(row.unresolved ?? 0),
      ambiguous: Number(row.ambiguous ?? 0),
    };
  } catch {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
    return null;
  }
}

async function enrichAmazonUnresolved(rows: CensusRow[], sb: SupabaseClient): Promise<void> {
  for (const name of [
    "amazon_amazon_fulfilled_inventory",
    "amazon_fba_inventory",
    "amazon_manage_fba_inventory",
    "amazon_returns",
  ] as const) {
    const row = rows.find((r) => r.name === name);
    if (!row || row.total_rows == null) continue;
    const unresolved = await countHead(sb, name, [
      { col: "resolved_product_id", op: "is", val: null },
      { col: "product_id", op: "is", val: null },
    ]);
    if (!unresolved.error) row.unresolved_rows = unresolved.count;
  }

  const settlements = rows.find((r) => r.name === "amazon_settlements");
  if (settlements && settlements.total_rows != null) {
    const u = await countHead(sb, "amazon_settlements", [{ col: "resolved_product_id", op: "is", val: null }]);
    if (!u.error) {
      settlements.unresolved_rows = u.count;
      settlements.read_layer_resolved = settlements.rows_with_product_link ?? 0;
    }
  }
}

function inferNextAction(r: CensusRow): NextAction {
  if (r.category === "package-pallet-aggregate" || r.name === "products" || r.name === "v_inventory_status") {
    return "no_product_link_needed";
  }
  if (r.name === "product_identifier_map") return "map-only";
  if (r.name === "expected_packages") {
    if ((r.ambiguous_rows ?? 0) > 0) return "manual_review";
    if ((r.unresolved_rows ?? 0) > 0) return "map-only";
    return "no_product_link_needed";
  }
  if (r.name === "amazon_settlements") return "sp_api_evidence";
  if (r.name === "amazon_fba_inventory" || r.name === "amazon_manage_fba_inventory") {
    return (r.unresolved_rows ?? 0) > 0 ? "trusted_product_promotion" : "map-only";
  }
  if (r.name.startsWith("amazon_")) {
    return (r.unresolved_rows ?? 0) > 0 ? "map-only" : "no_product_link_needed";
  }
  if (r.category === "claim") return "manual_review";
  if (r.name === "slip_contents" || r.name === "shipment_box_items") return "manual_review";
  if (r.name === "return_items") {
    return (r.unresolved_rows ?? 0) > 0 ? "map-only" : "no_product_link_needed";
  }
  if (r.category === "view-read-model") return "manual_review";
  return "manual_review";
}

const PRIORITY_WEIGHT: Record<string, number> = {
  expected_packages: 1_000_000,
  return_items: 900_000,
  slip_contents: 800_000,
  amazon_amazon_fulfilled_inventory: 700_000,
  claim_candidate_drafts: 600_000,
  claim_candidates: 550_000,
  shipment_box_items: 500_000,
  v_inventory_item_status: 400_000,
  amazon_manage_fba_inventory: 300_000,
  amazon_returns: 250_000,
  amazon_settlements: 50_000,
};

function topUnresolved(rows: CensusRow[]): { name: string; unresolved_rows: number; safest_next_action: NextAction }[] {
  return rows
    .filter((r) => r.category !== "catalog-spine" && r.name !== "v_inventory_status")
    .map((r) => {
      const unresolved =
        r.unresolved_rows ??
        Math.max(0, (r.total_rows ?? 0) - (r.read_layer_resolved ?? r.rows_with_product_link ?? 0));
      const weight = PRIORITY_WEIGHT[r.name] ?? (r.category === "report-source" ? 100 : 10);
      return {
        name: r.name,
        unresolved_rows: unresolved,
        safest_next_action: r.safest_next_action,
        score: weight * 1000 + unresolved,
      };
    })
    .filter((r) => r.unresolved_rows > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ name, unresolved_rows, safest_next_action }) => ({ name, unresolved_rows, safest_next_action }));
}

function buildNextWaves(rows: CensusRow[]): string {
  const ep = rows.find((r) => r.name === "expected_packages");
  const ri = rows.find((r) => r.name === "return_items");
  const sc = rows.find((r) => r.name === "slip_contents");

  return [
    "# PC01 — Next safe waves",
    "",
    `Staging ref: \`${STAGING_REF}\`. Read-only baseline; no executes in this prompt.`,
    "",
    "## Wave 0 — expected_packages (highest priority)",
    "",
    `- Read-layer: ${ep?.read_layer_resolved ?? "?"}/${ep?.total_rows ?? "?"} resolved; ${ep?.unresolved_rows ?? "?"} unresolved; ${ep?.ambiguous_rows ?? "?"} ambiguous`,
    "- Sub-waves (from V201/V202): source identifier fix (38 dirty), source disagreement (6), API 404 manual (5)",
    "- Safest action: **map-only** for clean identifier rows; **manual_review** for dirty/ambiguous",
    "",
    "## Wave 1 — return_items + slip_contents",
    "",
    `- return_items: ${ri?.read_layer_resolved ?? ri?.rows_with_product_link ?? "?"}/${ri?.total_rows ?? "?"} resolved; ${ri?.unresolved_rows ?? "?"} unresolved`,
    `- slip_contents: ${sc?.read_layer_resolved ?? sc?.rows_with_product_link ?? "?"}/${sc?.total_rows ?? "?"} resolved; ${sc?.unresolved_rows ?? "?"} unresolved`,
    "- Safest action: resolver-on-save persist; governed map backfill for gaps only",
    "",
    "## Wave 2 — Amazon report tables",
    "",
    "- AFI / amazon_returns: map-only refresh on unresolved import rows",
    "- FBA / manage FBA: trusted_product_promotion where name-only spine missing",
    "- amazon_settlements: sp_api_evidence or read-layer only (no product create)",
    "",
    "## Wave 3 — Claims",
    "",
    "- claim_candidates / claim_candidate_drafts: manual_review — fix upstream source linkage first",
    "",
    "## Do not link (aggregate / spine)",
    "",
    "- products, packages, pallets, shipment_boxes, shipment_containers, v_inventory_status",
  ].join("\n");
}

function buildBlockers(rows: CensusRow[], branch: string, gitClean: boolean): string {
  const branchOk = branch === "feature/product-canonicalization-v2";
  return [
    "# PC01 — Blockers",
    "",
    "## Preflight",
    "",
    `- Branch: \`${branch}\` — ${branchOk ? "OK" : "**MISMATCH** (required feature/product-canonicalization-v2)"}`,
    `- Git clean: ${gitClean ? "yes" : "**no** (uncommitted changes present)"}`,
    `- Active target: staging \`${STAGING_REF}\``,
    `- Original ref: \`${ORIGINAL_REF}\` (not queried)`,
    "",
    "## Query",
    "",
    ...rows
      .filter((r) => r.query_errors.length > 0)
      .map((r) => `- **${r.name}**: ${r.query_errors.join("; ")}`),
    ...(rows.some((r) => r.query_errors.length) ? [] : ["- No Supabase count errors on scoped tables."]),
    "",
    "## Policy",
    "",
    "- No DB writes, Amazon API, product create, or map insert in this prompt.",
    "- `package_items` forbidden; legacy `returns` forbidden.",
    "- No auto-create from title/OCR/UI.",
  ].join("\n");
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const outDir = path.resolve(process.cwd(), OUT_BASE, id);
  fs.mkdirSync(outDir, { recursive: true });

  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const gitClean = !execSync("git status --short", { encoding: "utf8" }).trim();

  const sb = sbClient();
  const rows: CensusRow[] = [];

  for (const spec of TABLE_SPECS) {
    rows.push(await censusTable(sb, spec));
  }

  for (const t of ["return_items", "expected_packages", "slip_contents"] as const) {
    const row = rows.find((r) => r.name === t);
    if (!row) continue;
    const rl = await pgReadLayer(t);
    if (rl) {
      row.read_layer_resolved = rl.read_layer_resolved;
      row.unresolved_rows = rl.unresolved;
      row.ambiguous_rows = rl.ambiguous;
    }
  }

  await enrichAmazonUnresolved(rows, sb);

  for (const r of rows) {
    if (r.unresolved_rows == null && r.total_rows != null) {
      const resolved = r.read_layer_resolved ?? r.rows_with_product_link ?? 0;
      r.unresolved_rows = Math.max(0, r.total_rows - resolved);
    }
    r.safest_next_action = inferNextAction(r);
  }

  const matrix = rows.map((r) => ({
    name: r.name,
    category: r.category,
    owner: r.owner,
    total_rows: r.total_rows,
    rows_with_product_id_or_resolved: r.rows_with_product_link,
    rows_with_identifiers_no_product_id: r.rows_with_identifiers_no_product_id,
    unresolved_rows: r.unresolved_rows,
    ambiguous_rows: r.ambiguous_rows,
    persist_mode: r.persist_mode,
    safest_next_action: r.safest_next_action,
    read_layer_resolved: r.read_layer_resolved,
    notes: r.notes,
    query_errors: r.query_errors,
  }));

  fs.writeFileSync(path.join(outDir, "table-linkage-matrix.json"), JSON.stringify(matrix, null, 2));

  const baselineMd = [
    "# PC01 — Product canonicalization baseline",
    "",
    `**Run id:** \`${id}\``,
    `**Branch:** \`${branch}\` | **Git clean:** ${gitClean}`,
    `**Staging ref:** \`${STAGING_REF}\` | **Original ref:** \`${ORIGINAL_REF}\` (not queried)`,
    `**Mode:** read-only (no DB writes)`,
    "",
    "| Table | Total | With product link | Id, no product | Unresolved | Ambiguous | Persist | Next action |",
    "|-------|------:|------------------:|---------------:|-----------:|----------:|---------|-------------|",
    ...rows.map(
      (r) =>
        `| ${r.name} | ${r.total_rows ?? "?"} | ${r.rows_with_product_link ?? "—"} | ${r.rows_with_identifiers_no_product_id ?? "—"} | ${r.unresolved_rows ?? "?"} | ${r.ambiguous_rows ?? "—"} | ${r.persist_mode} | ${r.safest_next_action} |`,
    ),
    "",
    "## Expected / slip / return status",
    "",
    ...["expected_packages", "slip_contents", "return_items"].map((n) => {
      const r = rows.find((x) => x.name === n)!;
      const resolved = r.read_layer_resolved ?? r.rows_with_product_link ?? "?";
      return `- **${n}**: ${resolved}/${r.total_rows ?? "?"} resolved; ${r.unresolved_rows ?? "?"} unresolved; ${r.ambiguous_rows ?? "—"} ambiguous → **${r.safest_next_action}** (${r.persist_mode})`;
    }),
    "",
    "## Catalog spine",
    "",
    `- **products:** ${rows.find((r) => r.name === "products")?.total_rows ?? "?"} rows`,
    `- **product_identifier_map (active):** ${rows.find((r) => r.name === "product_identifier_map")?.total_rows ?? "?"} rows`,
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "product-canonicalization-baseline.md"), `${baselineMd}\n`);

  const top = topUnresolved(rows);
  fs.writeFileSync(
    path.join(outDir, "unresolved-priority-list.md"),
    [
      "# Unresolved priority list (top 5 tables)",
      "",
      "| Rank | Table | Unresolved | Safest next action |",
      "|-----:|-------|----------:|--------------------|",
      ...top.map((t, i) => `| ${i + 1} | ${t.name} | ${t.unresolved_rows} | ${t.safest_next_action} |`),
      "",
    ].join("\n"),
  );

  fs.writeFileSync(path.join(outDir, "next-safe-waves.md"), `${buildNextWaves(rows)}\n`);
  fs.writeFileSync(path.join(outDir, "blockers.md"), buildBlockers(rows, branch, gitClean));

  const expectedSlipReturn = Object.fromEntries(
    ["expected_packages", "slip_contents", "return_items"].map((n) => {
      const r = rows.find((x) => x.name === n)!;
      return [
        n,
        {
          total: r.total_rows,
          resolved: r.read_layer_resolved ?? r.rows_with_product_link,
          unresolved: r.unresolved_rows,
          ambiguous: r.ambiguous_rows,
          persist_mode: r.persist_mode,
          safest_next_action: r.safest_next_action,
        },
      ];
    }),
  );

  const manifest = {
    prompt: "PC01 — PRODUCT CANONICALIZATION BASELINE",
    run_id: id,
    branch,
    branch_required: "feature/product-canonicalization-v2",
    git_clean: gitClean,
    staging_ref: STAGING_REF,
    original_ref: ORIGINAL_REF,
    status: rows.some((r) => r.query_errors.length) ? "CONDITIONAL_PASS" : "PASS",
    table_count: rows.length,
    products_total: rows.find((r) => r.name === "products")?.total_rows ?? null,
    active_map_rows: rows.find((r) => r.name === "product_identifier_map")?.total_rows ?? null,
    top_unresolved_tables: top,
    expected_slip_return: expectedSlipReturn,
    next_prompt: "PC02 — EXPECTED-PACKAGES-CANONICALIZATION-WAVE",
    forbidden: {
      db_mutations: false,
      production_touched: false,
      amazon_api: false,
      ai_openai: false,
      package_items: false,
      legacy_returns_table: false,
    },
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
