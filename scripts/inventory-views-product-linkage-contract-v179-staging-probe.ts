/**
 * INVENTORY-VIEWS-PRODUCT-LINKAGE-CONTRACT-V179 — staging view probe (read-only).
 *
 *   npx tsx scripts/inventory-views-product-linkage-contract-v179-staging-probe.ts --run-id=<id>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";

import {
  buildNedaInventoryItemStatusRow,
  classifyViewLinkage,
  type InventoryViewDbRow,
} from "../lib/inventory-views-product-linkage";
import { assessInventoryViewsReadiness } from "../lib/inventory-views-product-linkage";
import type { InventoryViewName } from "../lib/inventory-views-neda-read-contract";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const VIEWS: InventoryViewName[] = [
  "v_scanned_items_counted",
  "v_inventory_status",
  "v_inventory_item_status",
];

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

type ViewProbe = {
  exists: boolean;
  definition: string | null;
  columns: string[];
  row_count: number | null;
  linkage_class: string;
  depends_on_package_items: boolean;
  depends_on_returns_table: boolean;
  source_tables: string[];
  sample_resolved: number;
  sample_total: number;
};

async function viewColumns(client: pg.Client, view: string): Promise<string[]> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [view],
  );
  return r.rows.map((x: { column_name: string }) => x.column_name);
}

async function viewDefinition(client: pg.Client, view: string): Promise<string | null> {
  const r = await client.query(`SELECT pg_get_viewdef($1::regclass, true) AS def`, [`public.${view}`]);
  return (r.rows[0]?.def as string) ?? null;
}

function extractSourceTables(def: string | null): string[] {
  if (!def) return [];
  const tables = new Set<string>();
  const re = /\b(?:FROM|JOIN)\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(def)) !== null) {
    const t = m[1]!.toLowerCase();
    if (!t.startsWith("v_") && t !== "lateral") tables.add(t);
  }
  return [...tables].sort();
}

function defReferences(def: string | null, name: string): boolean {
  if (!def) return false;
  return new RegExp(`\\b${name}\\b`, "i").test(def);
}

async function probeView(client: pg.Client, view: string): Promise<ViewProbe> {
  const existsRes = await client.query(
    `SELECT 1 FROM information_schema.views WHERE table_schema = 'public' AND table_name = $1`,
    [view],
  );
  const exists = (existsRes.rowCount ?? 0) > 0;
  if (!exists) {
    return {
      exists: false,
      definition: null,
      columns: [],
      row_count: null,
      linkage_class: "missing_linkage",
      depends_on_package_items: false,
      depends_on_returns_table: false,
      source_tables: [],
      sample_resolved: 0,
      sample_total: 0,
    };
  }

  const definition = await viewDefinition(client, view);
  const columns = await viewColumns(client, view);
  const countRes = await client.query(`SELECT COUNT(*)::bigint AS n FROM public."${view}"`);
  const row_count = Number(countRes.rows[0]?.n ?? 0);
  const linkage_class = classifyViewLinkage(view, columns);

  return {
    exists: true,
    definition,
    columns,
    row_count,
    linkage_class,
    depends_on_package_items: defReferences(definition, "package_items"),
    depends_on_returns_table: defReferences(definition, "returns") && !defReferences(definition, "return_items"),
    source_tables: extractSourceTables(definition),
    sample_resolved: 0,
    sample_total: 0,
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(
    process.cwd(),
    ".cursor/audit-reports/inventory-views-product-linkage-contract-v179",
    runId,
  );
  fs.mkdirSync(outDir, { recursive: true });

  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  const url = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const key = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const ref = refFromSupabaseUrl(url) || refFromSupabaseUrl(dbUrl);

  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify({ run_id: runId, status: "FAIL", error: "staging ref guard" }, null, 2),
    );
    process.exit(2);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query(`SET statement_timeout = '120s'`);

  const pkgItems = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='package_items'`,
  );
  const packageItemsExists = (pkgItems.rowCount ?? 0) > 0;

  const probes: Record<string, ViewProbe> = {};
  for (const v of VIEWS) {
    probes[v] = await probeView(client, v);
  }

  await client.end();

  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const nedaRows = [];
  if (probes.v_inventory_item_status?.exists) {
    const { data: sample } = await supabase.from("v_inventory_item_status").select("*").limit(20);
    const linkageClass = classifyViewLinkage(
      "v_inventory_item_status",
      probes.v_inventory_item_status.columns,
    );
    for (const row of (sample ?? []) as InventoryViewDbRow[]) {
      const built = await buildNedaInventoryItemStatusRow(supabase, row, linkageClass);
      nedaRows.push(built);
      if (built.product_linkage.is_resolved) probes.v_inventory_item_status.sample_resolved += 1;
    }
    probes.v_inventory_item_status.sample_total = (sample ?? []).length;
  }

  const viewsPresent = Object.fromEntries(VIEWS.map((v) => [v, probes[v]!.exists])) as Record<
    InventoryViewName,
    boolean
  >;
  const readiness = assessInventoryViewsReadiness(viewsPresent, nedaRows);

  const forbiddenDeps =
    packageItemsExists ||
    VIEWS.some((v) => probes[v]!.depends_on_package_items || probes[v]!.depends_on_returns_table);

  const viewStatus = (v: InventoryViewName): string => {
    const p = probes[v]!;
    if (!p.exists) return "MISSING";
    if (p.depends_on_package_items || p.depends_on_returns_table) return "BLOCKED";
    return p.linkage_class.toUpperCase().replace(/_/g, "-");
  };

  const ddlNeeded =
    probes.v_inventory_item_status?.exists &&
    !probes.v_inventory_item_status.columns.includes("resolved_product_id") &&
    probes.v_inventory_item_status.linkage_class !== "product_linked";

  fs.writeFileSync(
    path.join(outDir, "view-definition-inventory.md"),
    [
      "# View definitions (staging)",
      "",
      `**Staging ref:** \`${STAGING_REF}\``,
      `**Probed:** ${new Date().toISOString()}`,
      "",
      ...VIEWS.flatMap((v) => {
        const p = probes[v]!;
        if (!p.exists) {
          return [`## ${v}`, "", "_View not found on staging._", ""];
        }
        return [
          `## ${v}`,
          "",
          `**Row count:** ${p.row_count ?? "?"}`,
          `**Linkage class:** ${p.linkage_class}`,
          `**Source tables:** ${p.source_tables.length ? p.source_tables.map((t) => `\`${t}\``).join(", ") : "_(parse from definition)_"}`,
          "",
          "### Definition",
          "",
          "```sql",
          p.definition ?? "-- unavailable",
          "```",
          "",
        ];
      }),
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "view-column-matrix.md"),
    [
      "# View column matrix",
      "",
      "| View | Exists | Rows | product_id | resolved_product_id | product_name | sku/fnsku/asin | store_id | qty/status cols | Class |",
      "|------|--------|------|------------|---------------------|--------------|----------------|----------|-----------------|-------|",
      ...VIEWS.map((v) => {
        const p = probes[v]!;
        const c = new Set(p.columns);
        const qtyCols = p.columns.filter((x) =>
          /quantity|count|scanned|expected|status|variance/i.test(x),
        );
        return [
          "|",
          v,
          "|",
          p.exists ? "yes" : "**no**",
          "|",
          p.row_count ?? "—",
          "|",
          c.has("product_id") ? "✓" : "—",
          "|",
          c.has("resolved_product_id") ? "✓" : "—",
          "|",
          c.has("product_name") || c.has("item_name") ? "✓" : "—",
          "|",
          ["sku", "fnsku", "asin"].filter((x) => c.has(x)).join("/") || "—",
          "|",
          c.has("store_id") ? "✓" : "—",
          "|",
          qtyCols.slice(0, 4).join(", ") || "—",
          "|",
          p.linkage_class,
          "|",
        ].join(" ");
      }),
      "",
      "### Dependency check",
      "",
      `| package_items table exists | ${packageItemsExists ? "**FAIL**" : "PASS (absent)"} |`,
      ...VIEWS.map((v) => {
        const p = probes[v]!;
        return `| ${v} → package_items | ${p.depends_on_package_items ? "**FAIL**" : "PASS"} |`;
      }),
      ...VIEWS.map((v) => {
        const p = probes[v]!;
        return `| ${v} → legacy \`returns\` (not return_items) | ${p.depends_on_returns_table ? "**FAIL**" : "PASS"} |`;
      }),
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "neda-inventory-read-contract.md"),
    [
      "# Neda inventory read contract (V179)",
      "",
      "**Types:** `lib/inventory-views-neda-read-contract.ts`",
      "**Enrichment:** `lib/inventory-views-product-linkage.ts`",
      "**Server:** `app/returns/inventory-views-linkage-actions.ts` → `fetchInventoryItemStatusForNeda`",
      "",
      "## Primary surface: `v_inventory_item_status`",
      "",
      "Each row maps to `NedaInventoryItemStatusRow`:",
      "",
      "- `source_row_id`, `organization_id`, `store_id`",
      "- `package_id`, `pallet_id`, `order_id`, `tracking_number`",
      "- `sku`, `fnsku`, `asin`",
      "- `expected_quantity`, `scanned_quantity`, `variance_status`",
      "- `inventory_status` (from view `status` / `inventory_status` column)",
      "- `product_linkage` — `ProductLinkageDisplayContract`",
      "- `linkage_class`, `linkage_source`",
      "",
      "## Supporting views",
      "",
      "- `v_inventory_status` — package/pallet-level aggregates; **not** line-level product display",
      "- `v_scanned_items_counted` — scan counters; aggregate-only for Neda KPIs",
      "",
      "## Consumption rule",
      "",
      "Neda UI should query **`fetchInventoryItemStatusForNeda`** (or Supabase read on `v_inventory_item_status` + server enrichment) — **not** ad-hoc joins to `products` in the browser.",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "view-update-ddl-plan-if-needed.md"),
    ddlNeeded
      ? [
          "# View update DDL plan (not applied — operator approval required)",
          "",
          "Option A — **preferred:** keep views as-is; enrich at read-time via `fetchInventoryItemStatusForNeda` (implemented V179).",
          "",
          "Option B — add resolver columns to underlying `return_items` / `expected_packages` and extend view SELECT:",
          "",
          "```sql",
          "-- Example: extend v_inventory_item_status (exact definition must match staging view body)",
          "CREATE OR REPLACE VIEW public.v_inventory_item_status AS",
          "SELECT",
          "  ri.*,",
          "  ri.resolved_product_id,",
          "  ri.identifier_resolution_status,",
          "  p.product_name",
          "FROM ... -- match current view joins",
          "LEFT JOIN public.products p ON p.id = ri.resolved_product_id;",
          "```",
          "",
          "**Forbidden:** package_items, `returns` table, fuzzy joins, production apply without approval.",
        ].join("\n")
      : [
          "# View update DDL plan",
          "",
          "Views already expose product linkage columns OR read-time enrichment is sufficient.",
          "No view migration required for V179 read path.",
        ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "implementation-summary-if-changed.md"),
    [
      "# Implementation summary",
      "",
      "## Code added (read helpers only — no view DDL)",
      "",
      "- `lib/inventory-views-neda-read-contract.ts`",
      "- `lib/inventory-views-product-linkage.ts`",
      "- `app/returns/inventory-views-linkage-actions.ts` — `fetchInventoryItemStatusForNeda`",
      "- `scripts/inventory-views-product-linkage-contract-v179-staging-probe.ts`",
      "",
      "## Views modified",
      "",
      "_None — staging view definitions unchanged._",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "validation-results.md"),
    [
      "# Validation results",
      "",
      `**Run:** ${runId}`,
      "",
      "| Check | Result |",
      "|-------|--------|",
      `| Staging ref | \`${STAGING_REF}\` |`,
      `| package_items absent | ${packageItemsExists ? "FAIL" : "PASS"} |`,
      `| Forbidden view deps | ${forbiddenDeps ? "FAIL" : "PASS"} |`,
      `| v_scanned_items_counted | ${viewStatus("v_scanned_items_counted")} |`,
      `| v_inventory_status | ${viewStatus("v_inventory_status")} |`,
      `| v_inventory_item_status | ${viewStatus("v_inventory_item_status")} |`,
      `| Sample resolved (item status, n=${probes.v_inventory_item_status?.sample_total ?? 0}) | ${probes.v_inventory_item_status?.sample_resolved ?? 0} |`,
      `| Neda readiness | **${readiness}** |`,
      "",
      "## Build",
      "",
      "_Run `npm run build` after probe — see post-run append._",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    [
      "# Blockers",
      "",
      !probes.v_inventory_item_status?.exists
        ? "- **FAIL:** `v_inventory_item_status` missing on staging — Neda cannot use inventory item status view."
        : "",
      packageItemsExists ? "- **FAIL:** `package_items` table exists (forbidden)." : "",
      VIEWS.filter((v) => probes[v]!.depends_on_package_items).length
        ? `- **FAIL:** Views reference package_items: ${VIEWS.filter((v) => probes[v]!.depends_on_package_items).join(", ")}`
        : "",
      VIEWS.filter((v) => probes[v]!.depends_on_returns_table).length
        ? `- **FAIL:** Views reference legacy returns table: ${VIEWS.filter((v) => probes[v]!.depends_on_returns_table).join(", ")}`
        : "",
      readiness === "PARTIAL"
        ? "- Staging `return_items` is sparse — linkage sample may show PARTIAL until more scans exist."
        : "",
      forbiddenDeps || !probes.v_inventory_item_status?.exists
        ? ""
        : "- None blocking read path via `fetchInventoryItemStatusForNeda`.",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  const nedaCanConsume =
    probes.v_inventory_item_status?.exists &&
    !probes.v_inventory_item_status.depends_on_package_items &&
    !probes.v_inventory_item_status.depends_on_returns_table &&
    readiness !== "FAIL";

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt_id: "INVENTORY-VIEWS-PRODUCT-LINKAGE-CONTRACT-V179",
        run_id: runId,
        status: forbiddenDeps || !probes.v_inventory_item_status?.exists ? "FAIL" : "PASS",
        linkage_readiness: readiness,
        v_scanned_items_counted: viewStatus("v_scanned_items_counted"),
        v_inventory_status: viewStatus("v_inventory_status"),
        v_inventory_item_status: viewStatus("v_inventory_item_status"),
        neda_can_consume_v_inventory_item_status_now: nedaCanConsume,
        ddl_needed: ddlNeeded,
        artifacts: [
          "view-definition-inventory.md",
          "view-column-matrix.md",
          "neda-inventory-read-contract.md",
          "view-update-ddl-plan-if-needed.md",
          "implementation-summary-if-changed.md",
          "validation-results.md",
          "blockers.md",
          "manifest.json",
        ],
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        run_id: runId,
        outDir,
        v_scanned_items_counted: viewStatus("v_scanned_items_counted"),
        v_inventory_status: viewStatus("v_inventory_status"),
        v_inventory_item_status: viewStatus("v_inventory_item_status"),
        neda_can_consume_v_inventory_item_status_now: nedaCanConsume,
        linkage_readiness: readiness,
      },
      null,
      2,
    ),
  );

  if (forbiddenDeps || !probes.v_inventory_item_status?.exists) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
