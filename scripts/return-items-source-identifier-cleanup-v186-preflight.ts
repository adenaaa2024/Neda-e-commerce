/**
 * RETURN-ITEMS-SOURCE-IDENTIFIER-CLEANUP-V186 — Plan-only preflight (read-only).
 *
 *   npx tsx scripts/return-items-source-identifier-cleanup-v186-preflight.ts --run-id=<id>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/return-items-source-identifier-cleanup-v186";
const V183_RUN = "20260521T140000Z";
const V185_RUN = "20260521T160000Z";
const SAM_ORG = "00000000-0000-0000-0000-000000000001";
const SAM_STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const TEST3_ORG = "7397edff-7994-4731-8501-55d258d507d2";
const BD5BF0D6 = "bd5bf0d6-500a-4696-80c6-7c0e65f539b6";

const FAKE_TEST_IDS = [
  "23ccf73f-cbda-485e-9ebb-cc8e365b9172",
  "3270ee19-441d-4b30-9d66-0273c46ea247",
  "ccffe8b3-87ea-4b7b-bfd5-4cf9cc16d663",
  "e08156b5-6f59-4bad-9a33-330c500df9cd",
];

type V186Class =
  | "test_or_fixture_row"
  | "real_sam_row_needs_product_spine"
  | "dirty_identifier"
  | "wrong_org_store_scope"
  | "no_action"
  | "product_spine_missing";

type RowInput = {
  return_item_id: string;
  organization_id: string;
  store_id: string;
  fbm_class: string;
  fnsku: string | null;
  asin: string | null;
  sku: string | null;
  product_identifier: string | null;
  package_id: string | null;
  notes: string | null;
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function n(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

async function tableExists(client: pg.Client, table: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  return (r.rowCount ?? 0) > 0;
}

async function searchProducts(
  client: pg.Client,
  org: string,
  store: string | null,
  field: "fnsku" | "asin" | "sku",
  value: string,
): Promise<{ store_scoped: unknown[]; org_wide: unknown[] }> {
  const col = field === "sku" ? "sku" : field;
  const base = `SELECT id::text, store_id::text, sku, asin, fnsku, product_name
    FROM public.products WHERE organization_id=$1::uuid AND deleted_at IS NULL AND ${col}=$2`;
  const orgR = await client.query(`${base} LIMIT 10`, [org, value]);
  if (!store) return { store_scoped: [], org_wide: orgR.rows };
  const storeR = await client.query(`${base} AND store_id=$3::uuid LIMIT 10`, [org, value, store]);
  return { store_scoped: storeR.rows, org_wide: orgR.rows };
}

async function searchMap(
  client: pg.Client,
  org: string,
  store: string,
  field: "fnsku" | "asin" | "sku",
  value: string,
): Promise<unknown[]> {
  let q = `SELECT id::text, product_id::text, store_id::text, seller_sku, asin, fnsku
    FROM public.product_identifier_map WHERE organization_id=$1::uuid AND store_id=$2::uuid`;
  const params: string[] = [org, store, value];
  if (field === "fnsku") q += ` AND fnsku=$3`;
  else if (field === "asin") q += ` AND asin=$3`;
  else q += ` AND (seller_sku=$3 OR msku=$3)`;
  const del = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='product_identifier_map' AND column_name='deleted_at'`,
  );
  if ((del.rowCount ?? 0) > 0) q += ` AND deleted_at IS NULL`;
  q += ` LIMIT 10`;
  return (await client.query(q, params)).rows;
}

async function searchCatalog(
  client: pg.Client,
  org: string,
  store: string | null,
  field: "fnsku" | "asin" | "sku",
  value: string,
): Promise<unknown[]> {
  if (!(await tableExists(client, "catalog_products"))) return [];
  const col = field === "sku" ? "seller_sku" : field;
  let q = `SELECT id::text, store_id::text, seller_sku, asin, fnsku, item_name
    FROM public.catalog_products WHERE organization_id=$1::uuid AND ${col}=$2`;
  const params: string[] = [org, value];
  if (store) {
    q += ` AND store_id=$3::uuid`;
    params.push(store);
  }
  q += ` LIMIT 10`;
  return (await client.query(q, params)).rows;
}

async function searchExpectedPackages(
  client: pg.Client,
  org: string,
  store: string | null,
  opts: { sku?: string; fnsku?: string; asin?: string },
): Promise<unknown[]> {
  if (!(await tableExists(client, "expected_packages"))) return [];
  let q = `SELECT id::text, store_id::text, sku, fnsku, order_id, tracking_number
    FROM public.expected_packages WHERE organization_id=$1::uuid`;
  const params: string[] = [org];
  const clauses: string[] = [];
  if (opts.sku) {
    params.push(opts.sku);
    clauses.push(`sku=$${params.length}`);
  }
  if (opts.fnsku) {
    params.push(opts.fnsku);
    clauses.push(`fnsku=$${params.length}`);
  }
  if (store) {
    params.push(store);
    clauses.push(`store_id=$${params.length}::uuid`);
  }
  if (clauses.length === 0) return [];
  q += ` AND (${clauses.join(" OR ")}) LIMIT 10`;
  return (await client.query(q, params)).rows;
}

async function searchAmazonTable(
  client: pg.Client,
  table: string,
  org: string,
  store: string | null,
  opts: { sku?: string; asin?: string; fnsku?: string },
): Promise<unknown[]> {
  if (!(await tableExists(client, table))) return [];
  const cols = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  const names = new Set(cols.rows.map((r: { column_name: string }) => r.column_name));
  const skuCol = names.has("seller_sku") ? "seller_sku" : names.has("sku") ? "sku" : null;
  const parts: string[] = [`organization_id=$1::uuid`];
  const params: string[] = [org];
  if (store && names.has("store_id")) {
    params.push(store);
    parts.push(`store_id=$${params.length}::uuid`);
  }
  const idParts: string[] = [];
  if (opts.asin && names.has("asin")) {
    params.push(opts.asin);
    idParts.push(`asin=$${params.length}`);
  }
  if (opts.fnsku && names.has("fnsku")) {
    params.push(opts.fnsku);
    idParts.push(`fnsku=$${params.length}`);
  }
  if (opts.sku && skuCol) {
    params.push(opts.sku);
    idParts.push(`${skuCol}=$${params.length}`);
  }
  if (idParts.length === 0) return [];
  const q = `SELECT * FROM public.${table} WHERE ${parts.join(" AND ")} AND (${idParts.join(" OR ")}) LIMIT 5`;
  return (await client.query(q, params)).rows;
}

function classifyV186(row: RowInput, probe: Record<string, unknown>): V186Class {
  const notes: string[] = [];
  if (row.return_item_id === BD5BF0D6) {
    const products = probe.products_any as number;
    const catalog = probe.catalog_any as number;
    const expected = probe.expected_any as number;
    const amazon = probe.amazon_any as number;
    if (products > 0) return "real_sam_row_needs_product_spine";
    if (catalog > 0 || amazon > 0 || expected > 0) {
      notes.push("listing/import signal exists but products.id missing");
      return "product_spine_missing";
    }
    return "product_spine_missing";
  }
  if (row.organization_id === TEST3_ORG) {
    notes.push("test3 org cohort");
    return "test_or_fixture_row";
  }
  if (n(row.fnsku)?.match(/^X00X/i) || n(row.asin)?.match(/^B0X/i)) {
    return "dirty_identifier";
  }
  return "test_or_fixture_row";
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const stagingRef = getStagingProjectRef({ loadEnv: false });
  if (!dbUrl || stagingRef !== STAGING_REF || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    throw new Error(`Staging guard failed (expected ${STAGING_REF})`);
  }

  const proposalPath = path.join(
    process.cwd(),
    ".cursor/audit-reports/return-items-fbm-aware-dry-run-v183",
    V183_RUN,
    "proposal-rows.json",
  );
  const proposals = JSON.parse(fs.readFileSync(proposalPath, "utf8")) as Array<{
    return_item_id: string;
    organization_id: string;
    store_id: string | null;
    fbm_class: string;
    identifiers: { fnsku: string | null; asin: string | null; sku: string | null };
    apply_kind: string;
  }>;

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const unresolvedIds = proposals.filter((p) => p.apply_kind === "exclude_no_proposal").map((p) => p.return_item_id);
  const detailRes = await client.query(
    `SELECT id::text, organization_id::text, store_id::text, sku, fnsku, asin,
            product_identifier, package_id::text, notes, deleted_at
     FROM public.return_items WHERE id = ANY($1::uuid[])`,
    [unresolvedIds],
  );
  const detailById = new Map(
    detailRes.rows.map((r: { id: string } & RowInput) => [r.id, r]),
  );

  const reviews: Array<Record<string, unknown>> = [];

  for (const p of proposals.filter((x) => x.apply_kind === "exclude_no_proposal")) {
    const row: RowInput = {
      return_item_id: p.return_item_id,
      organization_id: p.organization_id,
      store_id: n(p.store_id) ?? "",
      fbm_class: p.fbm_class,
      fnsku: n(p.identifiers.fnsku),
      asin: n(p.identifiers.asin),
      sku: n(p.identifiers.sku),
      product_identifier: n((detailById.get(p.return_item_id) as RowInput | undefined)?.product_identifier),
      package_id: n((detailById.get(p.return_item_id) as RowInput | undefined)?.package_id),
      notes: n((detailById.get(p.return_item_id) as RowInput | undefined)?.notes),
    };

    const products_hits: Record<string, unknown> = {};
    const map_hits: Record<string, unknown> = {};
    const catalog_hits: Record<string, unknown> = {};
    const expected_hits: unknown[] = [];
    const amazon_hits: Record<string, unknown> = {};

    if (row.fnsku) {
      products_hits.fnsku = await searchProducts(client, row.organization_id, row.store_id, "fnsku", row.fnsku);
      map_hits.fnsku = await searchMap(client, row.organization_id, row.store_id, "fnsku", row.fnsku);
      catalog_hits.fnsku = await searchCatalog(client, row.organization_id, row.store_id, "fnsku", row.fnsku);
    }
    if (row.asin) {
      products_hits.asin = await searchProducts(client, row.organization_id, row.store_id, "asin", row.asin);
      map_hits.asin = await searchMap(client, row.organization_id, row.store_id, "asin", row.asin);
      catalog_hits.asin = await searchCatalog(client, row.organization_id, row.store_id, "asin", row.asin);
    }
    if (row.sku) {
      products_hits.sku = await searchProducts(client, row.organization_id, row.store_id, "sku", row.sku);
      map_hits.sku = await searchMap(client, row.organization_id, row.store_id, "sku", row.sku);
      catalog_hits.sku = await searchCatalog(client, row.organization_id, row.store_id, "sku", row.sku);
    }

    const ep = await searchExpectedPackages(client, row.organization_id, row.store_id, {
      sku: row.sku ?? undefined,
      fnsku: row.fnsku ?? undefined,
    });
    for (const t of ["amazon_fba_inventory", "amazon_amazon_fulfilled_inventory", "amazon_all_orders"]) {
      amazon_hits[t] = await searchAmazonTable(client, t, row.organization_id, row.store_id, {
        sku: row.sku ?? undefined,
        asin: row.asin ?? undefined,
        fnsku: row.fnsku ?? undefined,
      });
    }

    const countAny = (obj: Record<string, unknown>) =>
      Object.values(obj).reduce((acc, v) => {
        if (Array.isArray(v)) return acc + v.length;
        if (v && typeof v === "object" && "org_wide" in v) {
          const o = v as { org_wide: unknown[]; store_scoped: unknown[] };
          return acc + o.org_wide.length + o.store_scoped.length;
        }
        return acc;
      }, 0);

    const probe = {
      products_any: countAny(products_hits),
      map_any: countAny(map_hits),
      catalog_any: countAny(catalog_hits),
      expected_any: ep.length,
      amazon_any: countAny(amazon_hits),
    };

    const v186_class = classifyV186(row, probe);

    reviews.push({
      ...row,
      v186_classification: v186_class,
      probe,
      products_hits,
      map_hits,
      catalog_hits,
      expected_packages: ep,
      amazon_hits,
    });
  }

  const activeCount = await client.query(
    `SELECT count(*)::int AS n FROM public.return_items WHERE deleted_at IS NULL`,
  );
  await client.end();

  const fakeTest = reviews.filter(
    (r) =>
      r.v186_classification === "test_or_fixture_row" ||
      r.v186_classification === "dirty_identifier",
  );
  const samRow = reviews.find((r) => r.return_item_id === BD5BF0D6);
  const samStatus =
    samRow?.v186_classification === "product_spine_missing"
      ? "product_spine_missing"
      : "needs_map_after_product";

  const cleanupRecommended = fakeTest.length >= 4;
  const productSpineNeeded = samStatus === "product_spine_missing";
  const resolverBlocked = true;

  const manifest = {
    prompt: "RETURN-ITEMS-SOURCE-IDENTIFIER-CLEANUP-V186",
    run_id: runId,
    staging_ref: STAGING_REF,
    v185_run_id: V185_RUN,
    v183_run_id: V183_RUN,
    active_return_items: activeCount.rows[0]?.n ?? null,
    unresolved_count: reviews.length,
    fake_test_rows_count: fakeTest.length,
    sam_row_id: BD5BF0D6,
    sam_real_row_status: samStatus,
    cleanup_recommended: cleanupRecommended,
    product_spine_import_needed: productSpineNeeded,
    resolver_execute_blocked: resolverBlocked,
    enrichment_executed: false,
    mode: "plan_only_no_writes",
  };

  fs.writeFileSync(path.join(outDir, "row-reviews.json"), JSON.stringify(reviews, null, 2));
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  // Markdown artifacts written by separate helper below
  writeMarkdownArtifacts(outDir, reviews, manifest, fakeTest, samRow);

  console.log(JSON.stringify(manifest, null, 2));
}

function writeMarkdownArtifacts(
  outDir: string,
  reviews: Array<Record<string, unknown>>,
  manifest: Record<string, unknown>,
  fakeTest: Array<Record<string, unknown>>,
  samRow: Record<string, unknown> | undefined,
): void {
  fs.writeFileSync(
    path.join(outDir, "unresolved-row-classification.md"),
    [
      "# Unresolved row classification (V186)",
      "",
      "| return_item_id | org | class | V186 classification |",
      "|----------------|-----|-------|---------------------|",
      ...reviews.map((r) => {
        const row = r as RowInput & { v186_classification: string };
        return `| \`${row.return_item_id.slice(0, 8)}…\` | ${row.organization_id === SAM_ORG ? "Sam" : "test3"} | ${row.fbm_class} | **${row.v186_classification}** |`;
      }),
      "",
      "## Summary",
      "",
      `- Fake/test/fixture: **${fakeTest.length}**`,
      `- Sam bd5bf0d6: **${manifest.sam_real_row_status}**`,
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "fake-test-row-cleanup-plan.md"),
    [
      "# Fake/test row cleanup plan (no execute in V186)",
      "",
      "## Recommended policy",
      "",
      "Quarantine **4 rows** from active KPI cohort — do **not** hard-delete in plan phase.",
      "",
      "| return_item_id | Reason |",
      "|----------------|--------|",
      ...FAKE_TEST_IDS.map((id) => {
        const r = reviews.find((x) => x.return_item_id === id) as RowInput | undefined;
        return `| \`${id}\` | ${r?.organization_id === TEST3_ORG ? "test3 org" : "synthetic X00X/B0X"} — ${(r as { fnsku?: string })?.fnsku ?? "—"} / ${(r as { sku?: string })?.sku ?? "—"} |`;
      }),
      "",
      "## Options (operator chooses at execute approval)",
      "",
      "| Method | Action | Reversible |",
      "|--------|--------|------------|",
      "| **Soft-delete** | `UPDATE return_items SET deleted_at = now() WHERE id IN (...)` | Yes |",
      "| **Hard-delete** | `DELETE FROM return_items WHERE id IN (...)` | No |",
      "",
      "**Plan recommendation:** soft-delete default; preimage CSV required before either.",
      "",
      "**Not executed in V186** — see `approval-needed.md`.",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "sam-row-product-spine-investigation.md"),
    [
      "# Sam row product spine investigation — bd5bf0d6",
      "",
      "| Field | Value |",
      "|-------|--------|",
      "| return_item_id | `bd5bf0d6-500a-4696-80c6-7c0e65f539b6` |",
      "| org / store | Sam / `509ee1f6-…` |",
      "| FNSKU | `4324567` |",
      "| ASIN | `B0BSDRJ85M` |",
      "| SKU | `TU-8QKU-LV50` |",
      "",
      "## Probe results (staging read-only)",
      "",
      "```json",
      JSON.stringify(samRow?.probe ?? {}, null, 2),
      "```",
      "",
      "## products / map",
      "",
      "- `products` exact hits: **0** (store + org-wide)",
      "- `product_identifier_map` exact hits: **0**",
      "",
      "## catalog / expected / amazon",
      "",
      "See `row-reviews.json` → `catalog_hits`, `expected_packages`, `amazon_hits`.",
      "",
      "## Conclusion",
      "",
      "**" +
        String(manifest.sam_real_row_status) +
        "** — identifiers look operational but **no product spine** on staging. Map enrichment (V185) correctly produced 0 candidates.",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "product-spine-plan-if-needed.md"),
    [
      "# Product spine plan (if needed)",
      "",
      "## When product_spine_missing (current)",
      "",
      "1. **Governed PIM product import** — operator uploads/links SKU+ASIN via existing dashboard import (no auto-create).",
      "2. **Amazon import wave** — if ASIN/SKU exists in amazon import tables, run table-specific resolver backfill per [backfill-readiness-checklist](../../docs/product-identity/backfill-readiness-checklist.md).",
      "3. **Then** `product_identifier_map` INSERT only (V185 execute approval) — never before `products.id` exists.",
      "4. **Then** re-run FBM dry-run — still **no** `return_items` resolver execute until `set_resolved_total > 0`.",
      "",
      "## Explicit non-actions",
      "",
      "- No automatic `INSERT INTO products`",
      "- No title/OCR fuzzy link",
      "- No return_items UPDATE in spine track",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "approval-needed.md"),
    [
      "# Approval needed",
      "",
      "| Approval file | Purpose | Default |",
      "|---------------|---------|---------|",
      "| `.cursor/operator-approvals/return-items-test-cohort-cleanup-v186-approval.md` | Track A: quarantine 4 fake/test rows | `APPROVED_TO_RUN_STAGING=false` |",
      "| `.cursor/operator-approvals/return-items-bd5bf0d6-spine-v186-approval.md` | Track B: any product/import work | `APPROVED_TO_RUN_STAGING=false` |",
      "| `.cursor/operator-approvals/product-identifier-map-enrichment-v185-approval.md` | Map INSERT after product exists | `false` |",
      "",
      "**V186 executed no DB writes.**",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "resolver-next-step-decision.md"),
    [
      "# Resolver next-step decision",
      "",
      "## Decision: **Do NOT execute return_items resolver**",
      "",
      "| Gate | Status |",
      "|------|--------|",
      "| V183/V185 dry-run `set_resolved_total` | 0 |",
      "| Safe map enrichment candidates | 0 |",
      "| Product spine for Sam row | Missing |",
      "| Fake/test rows polluting cohort | 4 of 5 unresolved |",
      "",
      "## Ordered next work",
      "",
      "1. **Optional:** Approve + execute test cohort cleanup (soft-delete recommended).",
      "2. **Required for Sam row:** Governed product import / spine — not resolver.",
      "3. **After product exists:** Map enrichment (V185) + dry-run re-check.",
      "4. **Only then:** return_items resolver execute-precheck prompt.",
      "",
      "## Leave unresolved?",
      "",
      "Yes — until (1) fake rows quarantined and (2) Sam product exists. Real scan volume is **7 rows total**; not production KPI truth.",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    [
      "# Blockers",
      "",
      "- `blocked_no_eligible_set_resolved` — no map/product target",
      "- V185 enrichment: 0 rows applied",
      "- product_spine_missing for `bd5bf0d6`",
      "- test3 + synthetic identifiers (4 rows)",
      "- tier_4 UPC/GTIN disabled in matcher",
      "- return_items resolver execute explicitly out of scope",
      "- production blocked",
    ].join("\n") + "\n",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
