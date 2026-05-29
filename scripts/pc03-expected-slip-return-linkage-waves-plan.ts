/**
 * PC03 — EXPECTED / SLIP / RETURN PRODUCT LINKAGE WAVES PLAN
 *
 * Read-only coverage + wave bucketing. No DB writes, no product create, no API.
 *
 *   npx tsx scripts/pc03-expected-slip-return-linkage-waves-plan.ts --run-id=<UTC_Z>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { classifyProductBarcode } from "../lib/product-barcode-classify";
import { resolveScannerProductIdentifiers } from "../lib/scanner-product-resolve";
import {
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/pc03-expected-slip-return-linkage-waves-plan";
const MAP_APPROVAL_PATH =
  ".cursor/operator-approvals/expected-slip-return-map-only-linkage-waves-pc03-approval.md";
const API404_EP_IDS = loadApi404EpIds();

type Bucket =
  | "map_only_existing_product"
  | "product_promotion_trusted_import"
  | "sp_api_evidence_needed"
  | "ambiguous"
  | "manual_review"
  | "invalid_test_dirty"
  | "missing_identifiers";

type Wave = "wave_a_map_only" | "wave_b_trusted_promotion" | "wave_c_sp_api_dry_run" | "wave_d_manual";

type RowBase = {
  table: string;
  row_id: string;
  organization_id: string;
  store_id: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  upc: string | null;
  resolved_product_id: string | null;
  product_id: string | null;
  read_bucket: string;
  map_distinct_product_ids: string[];
  trusted_source_product_count: number;
  trusted_single_product_id: string | null;
  trusted_sample_product_name: string | null;
  trusted_sample_asin: string | null;
  bucket: Bucket;
  wave: Wave;
  resolver_status: string | null;
  resolver_product_id: string | null;
  map_only_candidate: boolean;
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function loadApi404EpIds(): Set<string> {
  const p = path.join(
    process.cwd(),
    ".cursor/audit-reports/expected-packages-amazon-api-evidence-execute-v202/20260522T210000Z/execute-lines.json",
  );
  if (!fs.existsSync(p)) return new Set();
  const lines = JSON.parse(fs.readFileSync(p, "utf8")) as Array<{
    expected_package_ids: string[];
    outcome: string;
  }>;
  const ids = new Set<string>();
  for (const line of lines) {
    if (line.outcome === "catalog_lookup_failed") {
      for (const id of line.expected_package_ids) ids.add(id);
    }
  }
  return ids;
}

function isDirty(row: Pick<RowBase, "sku" | "fnsku" | "store_id">): boolean {
  const sku = (row.sku ?? "").trim().toUpperCase();
  const fnsku = (row.fnsku ?? "").trim().toUpperCase();
  if (!row.store_id) return true;
  if (/^(TEST|DUMMY|PLACEHOLDER|UNKNOWN|UNKNOW)$/i.test(sku)) return true;
  if (/^(TEST|DUMMY)$/i.test(fnsku)) return true;
  if (/^B[0-9A-Z]{9}$/.test(fnsku)) return true;
  return false;
}

function classifyBucket(row: Omit<RowBase, "bucket" | "wave" | "resolver_status" | "resolver_product_id" | "map_only_candidate">, epId?: string): { bucket: Bucket; wave: Wave; map_only_candidate: boolean } {
  const mapIds = row.map_distinct_product_ids;
  const mapAmbiguous = mapIds.length > 1;

  if (isDirty(row)) {
    return { bucket: "invalid_test_dirty", wave: "wave_d_manual", map_only_candidate: false };
  }
  if (!row.sku && !row.fnsku && !row.asin && !row.upc) {
    return { bucket: "missing_identifiers", wave: "wave_d_manual", map_only_candidate: false };
  }
  if (mapAmbiguous) {
    return { bucket: "ambiguous", wave: "wave_d_manual", map_only_candidate: false };
  }
  if (
    row.trusted_source_product_count === 1 &&
    row.trusted_single_product_id &&
    mapIds.length === 0 &&
    !row.resolved_product_id &&
    !row.product_id
  ) {
    return { bucket: "map_only_existing_product", wave: "wave_a_map_only", map_only_candidate: true };
  }
  if (row.trusted_source_product_count > 1) {
    return { bucket: "ambiguous", wave: "wave_d_manual", map_only_candidate: false };
  }
  if (row.trusted_sample_product_name && row.trusted_source_product_count === 0 && mapIds.length === 0) {
    return { bucket: "product_promotion_trusted_import", wave: "wave_b_trusted_promotion", map_only_candidate: false };
  }
  const asin = row.asin ?? row.trusted_sample_asin;
  if (row.table === "expected_packages" && asin && /^B[0-9A-Z]{9}$/i.test(asin.trim()) && row.store_id) {
    if (epId && API404_EP_IDS.has(epId)) {
      return { bucket: "manual_review", wave: "wave_d_manual", map_only_candidate: false };
    }
    return { bucket: "sp_api_evidence_needed", wave: "wave_c_sp_api_dry_run", map_only_candidate: false };
  }
  return { bucket: "manual_review", wave: "wave_d_manual", map_only_candidate: false };
}

async function tableColumns(client: pg.Client, table: string): Promise<Set<string>> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  return new Set(r.rows.map((x: { column_name: string }) => x.column_name));
}

function idColExprs(cols: Set<string>, alias?: string): { sku: string; fnsku: string; asin: string; upc: string } {
  const p = alias ? `${alias}.` : "";
  const e = (n: string) => (cols.has(n) ? `NULLIF(TRIM(${p}${n}), '')` : "NULL::text");
  return { sku: e("sku"), fnsku: e("fnsku"), asin: e("asin"), upc: e("upc") };
}

function mapSkuCte(cols: Set<string>, baseAlias: string): string {
  if (!cols.has("sku")) {
    return `
    map_sku AS (
      SELECT b.id, 0::int AS c
      FROM ${baseAlias} b
    )`;
  }
  return `
    map_sku AS (
      SELECT b.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
      FROM ${baseAlias} b
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id = b.organization_id AND m.store_id = b.store_id
       AND m.deleted_at IS NULL AND b.sku IS NOT NULL AND (m.seller_sku = b.sku OR m.msku = b.sku)
      GROUP BY b.id
    )`;
}

function mapSkuCteDetailed(cols: Set<string>, baseAlias: string): string {
  if (!cols.has("sku")) {
    return `
    map_sku AS (
      SELECT ep.id, 0::int AS product_count, ARRAY[]::text[] AS product_ids
      FROM ${baseAlias} ep
    )`;
  }
  return `
    map_sku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS product_count,
        ARRAY_AGG(DISTINCT m.product_id::text) FILTER (WHERE m.product_id IS NOT NULL) AS product_ids
      FROM ${baseAlias} ep
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id=ep.organization_id AND m.store_id=ep.store_id
       AND m.deleted_at IS NULL AND ep.sku IS NOT NULL AND (m.seller_sku=ep.sku OR m.msku=ep.sku)
      GROUP BY ep.id
    )`;
}

async function coverage(client: pg.Client, table: "expected_packages" | "return_items" | "slip_contents") {
  const cols = await tableColumns(client, table);
  const ids = idColExprs(cols);
  const filters: Record<string, string> = {
    expected_packages: "",
    return_items: "WHERE deleted_at IS NULL",
    slip_contents: "",
  };
  const hasProductId = cols.has("product_id");
  const r = await client.query(`
    WITH base AS (
      SELECT id, organization_id, store_id,
        ${ids.sku} AS sku, ${ids.fnsku} AS fnsku,
        ${ids.asin} AS asin,
        ${hasProductId ? "product_id," : ""} resolved_product_id
      FROM public.${table} ${filters[table]}
    ),
    map_fnsku AS (
      SELECT b.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
      FROM base b
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id = b.organization_id AND m.store_id = b.store_id
       AND m.deleted_at IS NULL AND b.fnsku IS NOT NULL AND m.fnsku = b.fnsku
      GROUP BY b.id
    ),
    ${mapSkuCte(cols, "base")},
    classified AS (
      SELECT b.id,
        CASE
          WHEN ${hasProductId ? "b.resolved_product_id IS NOT NULL OR b.product_id IS NOT NULL" : "b.resolved_product_id IS NOT NULL"} THEN 'resolved'
          WHEN COALESCE(mf.c,0)=1 OR COALESCE(ms.c,0)=1 THEN 'resolved'
          WHEN COALESCE(mf.c,0)>1 OR COALESCE(ms.c,0)>1 THEN 'ambiguous'
          WHEN b.sku IS NULL AND b.fnsku IS NULL AND b.asin IS NULL THEN 'missing_identifiers'
          ELSE 'unresolved'
        END AS bucket
      FROM base b
      LEFT JOIN map_fnsku mf ON mf.id=b.id
      LEFT JOIN map_sku ms ON ms.id=b.id
    )
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE bucket='resolved')::int AS read_layer_resolved,
      COUNT(*) FILTER (WHERE bucket='unresolved')::int AS unresolved,
      COUNT(*) FILTER (WHERE bucket='ambiguous')::int AS ambiguous,
      COUNT(*) FILTER (WHERE bucket='missing_identifiers')::int AS missing_identifiers
    FROM classified
  `);
  return r.rows[0] as Record<string, number>;
}

async function fetchUnresolved(client: pg.Client, table: "expected_packages" | "return_items" | "slip_contents") {
  const cols = await tableColumns(client, table);
  const ids = idColExprs(cols, "e");
  const hasProductId = cols.has("product_id");
  const filter = table === "return_items" ? "AND e.deleted_at IS NULL" : "";
  const trustedLateral = `
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT source_product_id) FILTER (WHERE source_product_id IS NOT NULL)::int AS source_product_count,
        MIN(product_name) FILTER (WHERE product_name IS NOT NULL) AS sample_product_name,
        MIN(source_asin) FILTER (WHERE source_asin IS NOT NULL) AS sample_asin,
        (ARRAY_AGG(DISTINCT source_product_id) FILTER (WHERE source_product_id IS NOT NULL))[1] AS single_product_id
      FROM (
        SELECT COALESCE(a.resolved_product_id, a.product_id) AS source_product_id, NULL::text AS product_name, NULLIF(TRIM(a.asin),'') AS source_asin
        FROM public.amazon_amazon_fulfilled_inventory a
        WHERE a.organization_id=ep.organization_id AND a.store_id=ep.store_id
          AND ((ep.fnsku IS NOT NULL AND a.fulfillment_channel_sku=ep.fnsku) OR (ep.sku IS NOT NULL AND a.seller_sku=ep.sku))
        UNION ALL
        SELECT COALESCE(f.resolved_product_id, f.product_id), NULLIF(TRIM(f.product_name),''), NULLIF(TRIM(f.asin),'')
        FROM public.amazon_fba_inventory f
        WHERE f.organization_id=ep.organization_id AND f.store_id=ep.store_id
          AND ((ep.fnsku IS NOT NULL AND f.fnsku=ep.fnsku) OR (ep.sku IS NOT NULL AND f.sku=ep.sku))
        UNION ALL
        SELECT COALESCE(mf.resolved_product_id, mf.product_id), NULLIF(TRIM(mf.product_name),''), NULLIF(TRIM(mf.asin),'')
        FROM public.amazon_manage_fba_inventory mf
        WHERE mf.organization_id=ep.organization_id AND mf.store_id=ep.store_id
          AND ((ep.fnsku IS NOT NULL AND mf.fnsku=ep.fnsku) OR (ep.sku IS NOT NULL AND mf.sku=ep.sku))
      ) s
    ) ts ON true`;

  const r = await client.query(`
    WITH ep AS (
      SELECT e.id, e.organization_id, e.store_id,
        ${ids.sku} AS sku, ${ids.fnsku} AS fnsku,
        ${ids.asin} AS asin, ${ids.upc} AS upc,
        e.resolved_product_id, ${hasProductId ? "e.product_id" : "NULL::uuid AS product_id"}
      FROM public.${table} e WHERE true ${filter}
    ),
    map_fnsku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS product_count,
        ARRAY_AGG(DISTINCT m.product_id::text) FILTER (WHERE m.product_id IS NOT NULL) AS product_ids
      FROM ep
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id=ep.organization_id AND m.store_id=ep.store_id
       AND m.deleted_at IS NULL AND ep.fnsku IS NOT NULL AND m.fnsku=ep.fnsku
      GROUP BY ep.id
    ),
    ${mapSkuCteDetailed(cols, "ep")},
    classified AS (
      SELECT ep.*,
        CASE
          WHEN ${hasProductId ? "ep.resolved_product_id IS NOT NULL OR ep.product_id IS NOT NULL" : "ep.resolved_product_id IS NOT NULL"} THEN 'resolved'
          WHEN COALESCE(mf.product_count,0)=1 OR COALESCE(ms.product_count,0)=1 THEN 'resolved'
          WHEN COALESCE(mf.product_count,0)>1 OR COALESCE(ms.product_count,0)>1 THEN 'ambiguous'
          ELSE 'unresolved'
        END AS read_bucket,
        (SELECT ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(mf.product_ids,ARRAY[]::text[])||COALESCE(ms.product_ids,ARRAY[]::text[])) x)) AS map_distinct_product_ids,
        ts.source_product_count, ts.sample_product_name, ts.sample_asin,
        CASE WHEN ts.source_product_count=1 THEN ts.single_product_id::text ELSE NULL END AS trusted_single_product_id
      FROM ep
      LEFT JOIN map_fnsku mf ON mf.id=ep.id
      LEFT JOIN map_sku ms ON ms.id=ep.id
      ${trustedLateral}
    )
    SELECT * FROM classified WHERE read_bucket IN ('unresolved','ambiguous')
  `);
  return r.rows as Record<string, unknown>[];
}

function tableMd(name: string, cov: Record<string, number>, rows: RowBase[]): string {
  const byBucket = new Map<string, number>();
  for (const r of rows) byBucket.set(r.bucket, (byBucket.get(r.bucket) ?? 0) + 1);
  return [
    `# ${name} — coverage`,
    "",
    `| Metric | Count |`,
    `|--------|------:|`,
    `| Total | ${cov.total ?? 0} |`,
    `| Read-layer resolved | ${cov.read_layer_resolved ?? 0} |`,
    `| Unresolved | ${cov.unresolved ?? 0} |`,
    `| Ambiguous | ${cov.ambiguous ?? 0} |`,
    `| Missing identifiers | ${cov.missing_identifiers ?? 0} |`,
    "",
    "## Unresolved bucket counts (review queue)",
    "",
    ...[...byBucket.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `- **${k}:** ${n}`),
    "",
  ].join("\n");
}

function writeMapOnlyApproval(runId: string, mapCandidates: RowBase[]): void {
  const content = `# Expected / slip / return map-only linkage — PC03 waves approval

**Default:** not approved. Required before Wave A map-only execute across EP / slip / return.

| Field | Value |
|-------|--------|
| Staging ref | \`${STAGING_REF}\` |
| Allowed write | INSERT \`product_identifier_map\` only for approved plan rows |
| Product creation | forbidden |
| Source table updates | forbidden |
| Production | forbidden |

\`\`\`text
APPROVED_TO_RUN_STAGING=false
APPROVED_EXPECTED_SLIP_RETURN_MAP_ONLY_LINKAGE_PC03=false
\`\`\`

## Plan reference

- \`.cursor/audit-reports/pc03-expected-slip-return-linkage-waves-plan/${runId}/\`
- Map-only candidates: **${mapCandidates.length}** rows

## Sign-off

\`\`\`
APPROVED_TO_RUN_STAGING=false
APPROVED_EXPECTED_SLIP_RETURN_MAP_ONLY_LINKAGE_PC03=false
Approved by:
UTC date:
\`\`\`
`;
  fs.writeFileSync(path.join(process.cwd(), MAP_APPROVAL_PATH), content);
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    throw new Error("Staging guard failed");
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url || !key || refFromSupabaseUrl(url) !== STAGING_REF) throw new Error("Supabase guard failed");
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '180s'");

  const tables = ["expected_packages", "slip_contents", "return_items"] as const;
  const coverageByTable: Record<string, Record<string, number>> = {};
  const allRows: RowBase[] = [];

  for (const table of tables) {
    coverageByTable[table] = await coverage(client, table);
    const raw = await fetchUnresolved(client, table);
    for (const r of raw) {
      const base: Omit<RowBase, "bucket" | "wave" | "resolver_status" | "resolver_product_id" | "map_only_candidate"> = {
        table,
        row_id: String(r.id),
        organization_id: String(r.organization_id),
        store_id: r.store_id ? String(r.store_id) : null,
        sku: r.sku ? String(r.sku) : null,
        fnsku: r.fnsku ? String(r.fnsku) : null,
        asin: r.asin ? String(r.asin) : null,
        upc: r.upc ? String(r.upc) : null,
        resolved_product_id: r.resolved_product_id ? String(r.resolved_product_id) : null,
        product_id: r.product_id ? String(r.product_id) : null,
        read_bucket: String(r.read_bucket),
        map_distinct_product_ids: Array.isArray(r.map_distinct_product_ids) ? (r.map_distinct_product_ids as string[]) : [],
        trusted_source_product_count: Number(r.source_product_count ?? 0),
        trusted_single_product_id: r.trusted_single_product_id ? String(r.trusted_single_product_id) : null,
        trusted_sample_product_name: r.sample_product_name ? String(r.sample_product_name) : null,
        trusted_sample_asin: r.sample_asin ? String(r.sample_asin) : null,
      };
      const epId = table === "expected_packages" ? base.row_id : undefined;
      const { bucket, wave, map_only_candidate } = classifyBucket(base, epId);

      let resolver_status: string | null = null;
      let resolver_product_id: string | null = null;
      if (base.store_id) {
        for (const code of [base.fnsku, base.asin, base.sku, base.upc].filter(Boolean) as string[]) {
          const c = classifyProductBarcode(code);
          const res = await resolveScannerProductIdentifiers(sb, {
            organizationId: base.organization_id,
            storeId: base.store_id,
            sku: c.kind === "sku_msku" ? c.normalized : null,
            asin: c.kind === "asin" ? c.normalized : null,
            fnsku: c.kind === "fnsku" ? c.normalized : null,
            upc: c.kind === "upc_ean" ? c.normalized : null,
            productIdentifier: c.normalized,
          });
          resolver_status = res.identifier_resolution_status;
          if (res.resolved_product_id) {
            resolver_product_id = res.resolved_product_id;
            break;
          }
        }
      }

      let finalBucket = bucket;
      let finalWave = wave;
      let finalMapOnly = map_only_candidate;
      if (
        bucket === "manual_review" &&
        resolver_status === "resolved" &&
        resolver_product_id &&
        base.map_distinct_product_ids.length === 0
      ) {
        finalBucket = "map_only_existing_product";
        finalWave = "wave_a_map_only";
        finalMapOnly = true;
      }

      allRows.push({
        ...base,
        bucket: finalBucket,
        wave: finalWave,
        resolver_status,
        resolver_product_id,
        map_only_candidate: finalMapOnly,
      });
    }
  }
  await client.end();

  const epRows = allRows.filter((r) => r.table === "expected_packages");
  const slipRows = allRows.filter((r) => r.table === "slip_contents");
  const riRows = allRows.filter((r) => r.table === "return_items");
  const mapCandidates = allRows.filter((r) => r.map_only_candidate);

  fs.writeFileSync(path.join(outDir, "expected-packages-coverage.md"), tableMd("expected_packages", coverageByTable.expected_packages!, epRows));
  fs.writeFileSync(path.join(outDir, "slip-contents-coverage.md"), tableMd("slip_contents", coverageByTable.slip_contents!, slipRows));
  fs.writeFileSync(path.join(outDir, "return-items-coverage.md"), tableMd("return_items", coverageByTable.return_items!, riRows));

  const wavePlan = [
    "# Linkage wave plan — expected / slip / return",
    "",
    `**Run id:** \`${runId}\``,
    `**Branch:** \`${branch}\``,
    "",
    "## Wave A — map-only (existing product)",
    "",
    `- Candidates: **${allRows.filter((r) => r.wave === "wave_a_map_only").length}**`,
    `- Approval: \`${MAP_APPROVAL_PATH}\` (default false)`,
    `- Execute prompt: **PC03A — EXPECTED-SLIP-RETURN-MAP-ONLY-EXECUTE** (not run in this prompt)`,
    "",
    "## Wave B — trusted product promotion",
    "",
    `- Candidates: **${allRows.filter((r) => r.wave === "wave_b_trusted_promotion").length}**`,
    `- Separate E2-style approval required; no product create in this prompt`,
    "",
    "## Wave C — SP-API evidence dry-run",
    "",
    `- Candidates: **${allRows.filter((r) => r.wave === "wave_c_sp_api_dry_run").length}** (expected_packages ASIN cohort only)`,
    `- Use existing \`sp-api-product-evidence-dry-run-pc02-approval.md\` gates`,
    "",
    "## Wave D — manual / dirty / ambiguous",
    "",
    `- **invalid_test_dirty:** ${allRows.filter((r) => r.bucket === "invalid_test_dirty").length}`,
    `- **manual_review:** ${allRows.filter((r) => r.bucket === "manual_review").length}`,
    `- **ambiguous:** ${allRows.filter((r) => r.bucket === "ambiguous").length}`,
    "",
    "### Table summary",
    "",
    "| Table | Total | Resolved | Unresolved review rows |",
    "|-------|------:|---------:|-----------------------:|",
    ...tables.map((t) => {
      const c = coverageByTable[t]!;
      const n = allRows.filter((r) => r.table === t).length;
      return `| ${t} | ${c.total} | ${c.read_layer_resolved} | ${n} |`;
    }),
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "linkage-wave-plan.md"), `${wavePlan}\n`);

  writeMapOnlyApproval(runId, mapCandidates);

  fs.writeFileSync(
    path.join(outDir, "approval-files-needed.md"),
    [
      "# Approval files needed",
      "",
      "| Wave | File | Status |",
      "|------|------|--------|",
      `| A map-only | \`${MAP_APPROVAL_PATH}\` | created default **false** |`,
      "| B promotion | `.cursor/operator-approvals/expected-slip-return-e2-promotion-pc03-approval.md` | **not created** — create when Wave B cohort > 0 |",
      "| C SP-API dry-run | `.cursor/operator-approvals/sp-api-product-evidence-dry-run-pc02-approval.md` | exists (check flags) |",
      "| Source disagreement map | `.cursor/operator-approvals/expected-packages-source-disagreement-map-pc03b-approval.md` | **executed** PC03B |",
    ].join("\n") + "\n",
  );

  const manualMd = [
    "# Manual review queue",
    "",
    "| table | row_id | fnsku | sku | bucket | wave | resolver |",
    "|-------|--------|-------|-----|--------|------|----------|",
    ...allRows
      .filter((r) => r.wave === "wave_d_manual" || r.bucket === "ambiguous")
      .slice(0, 200)
      .map(
        (r) =>
          `| ${r.table} | \`${r.row_id}\` | ${r.fnsku ?? "—"} | ${r.sku ?? "—"} | ${r.bucket} | ${r.wave} | ${r.resolver_status ?? "—"} |`,
      ),
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "manual-review-queue.md"), `${manualMd}\n`);

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    [
      "# Blockers",
      "",
      "- Read-only plan; no DB writes.",
      `- Wave A approval default **false** in \`${MAP_APPROVAL_PATH}\`.`,
      "- **38+ dirty** expected_packages rows block bulk map/API until source fix.",
      "- slip_contents: small cohort — prefer manual or resolver-on-save persist, not bulk promotion.",
    ].join("\n") + "\n",
  );

  const bucketCounts = Object.fromEntries(
    [...new Set(allRows.map((r) => r.bucket))].map((b) => [b, allRows.filter((r) => r.bucket === b).length]),
  );

  const manifest = {
    prompt: "PC03 — EXPECTED / SLIP / RETURN PRODUCT LINKAGE WAVES PLAN",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    status: "PASS",
    coverage: coverageByTable,
    unresolved_review_rows: {
      expected_packages: epRows.length,
      slip_contents: slipRows.length,
      return_items: riRows.length,
    },
    bucket_counts: bucketCounts,
    map_only_candidates: mapCandidates.length,
    map_approval_file: MAP_APPROVAL_PATH,
    safest_execute_prompt:
      mapCandidates.length > 0
        ? "PC03A — EXPECTED-SLIP-RETURN-MAP-ONLY-EXECUTE (after approval)"
        : "PC03 — EXPECTED-PACKAGES-DIRTY-SOURCE-QUARANTINE-PLAN",
    forbidden: { db_writes: false, product_create: false, amazon_api: false },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
