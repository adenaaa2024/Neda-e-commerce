/**
 * PC03A — EXPECTED / RETURN / SLIP MAP-ONLY EXECUTE PLAN
 *
 * Read-only: recompute coverage, exact deterministic map-only candidates, approval stubs.
 * No DB writes, no product create, no API, no fuzzy/title/OCR matching.
 *
 *   npx tsx scripts/pc03a-expected-return-slip-map-only-execute-plan.ts --run-id=<UTC_Z>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import {
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/pc03a-expected-return-slip-map-only-execute-plan";
const APPROVAL_RETURN = ".cursor/operator-approvals/pc03a-return-items-map-only-backfill-approval.md";
const APPROVAL_SLIP = ".cursor/operator-approvals/pc03a-slip-contents-map-only-backfill-approval.md";
const APPROVAL_EP_SOURCE = ".cursor/operator-approvals/pc03a-expected-packages-source-fix-approval.md";
const MATCH_SOURCE = "pc03a_exact_map_only";

type TableName = "expected_packages" | "return_items" | "slip_contents";

type ExactCandidate = {
  table: TableName;
  row_id: string;
  organization_id: string;
  store_id: string;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  upc: string | null;
  recommended_product_id: string;
  match_via: string[];
  proposed_actions: string[];
  map_insert: {
    product_id: string;
    seller_sku: string | null;
    msku: string | null;
    fnsku: string | null;
    asin: string | null;
    match_source: string;
  } | null;
};

type Exclusion = {
  table: TableName;
  row_id: string;
  reason: string;
  sku: string | null;
  fnsku: string | null;
  proof_product_ids: string[];
  proof_sources: string[];
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

function isDirty(row: {
  sku: string | null;
  fnsku: string | null;
  store_id: string | null;
}): boolean {
  const sku = (row.sku ?? "").trim().toUpperCase();
  const fnsku = (row.fnsku ?? "").trim().toUpperCase();
  if (!row.store_id) return true;
  if (/^(TEST|DUMMY|PLACEHOLDER|UNKNOWN|UNKNOW)$/i.test(sku)) return true;
  if (/^(TEST|DUMMY)$/i.test(fnsku)) return true;
  if (/^B[0-9A-Z]{9}$/.test(fnsku)) return true;
  return false;
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

async function coverage(client: pg.Client, table: TableName) {
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

async function fetchUnresolvedWithProofs(client: pg.Client, table: TableName) {
  const cols = await tableColumns(client, table);
  const ids = idColExprs(cols, "e");
  const hasProductId = cols.has("product_id");
  const filter = table === "return_items" ? "AND e.deleted_at IS NULL" : "";

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
    map_sku AS (
      SELECT ep.id,
        ${cols.has("sku")
          ? `COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS product_count,
        ARRAY_AGG(DISTINCT m.product_id::text) FILTER (WHERE m.product_id IS NOT NULL) AS product_ids`
          : `0::int AS product_count, ARRAY[]::text[] AS product_ids`}
      FROM ep
      ${cols.has("sku")
        ? `LEFT JOIN public.product_identifier_map m
        ON m.organization_id=ep.organization_id AND m.store_id=ep.store_id
       AND m.deleted_at IS NULL AND ep.sku IS NOT NULL AND (m.seller_sku=ep.sku OR m.msku=ep.sku)
      GROUP BY ep.id`
        : `GROUP BY ep.id`}
    ),
    unresolved AS (
      SELECT ep.*,
        CASE
          WHEN ${hasProductId ? "ep.resolved_product_id IS NOT NULL OR ep.product_id IS NOT NULL" : "ep.resolved_product_id IS NOT NULL"} THEN 'resolved'
          WHEN COALESCE(mf.product_count,0)=1 OR COALESCE(ms.product_count,0)=1 THEN 'resolved'
          WHEN COALESCE(mf.product_count,0)>1 OR COALESCE(ms.product_count,0)>1 THEN 'ambiguous'
          ELSE 'unresolved'
        END AS read_bucket,
        COALESCE(mf.product_ids, ARRAY[]::text[]) || COALESCE(ms.product_ids, ARRAY[]::text[]) AS map_product_ids
      FROM ep
      LEFT JOIN map_fnsku mf ON mf.id=ep.id
      LEFT JOIN map_sku ms ON ms.id=ep.id
    ),
    proof AS (
      SELECT u.id AS row_id, x.src, x.pid::text AS pid
      FROM unresolved u
      CROSS JOIN LATERAL (
        SELECT 'products.exact_fnsku'::text AS src, p.id AS pid
        FROM public.products p
        WHERE p.organization_id = u.organization_id AND p.store_id = u.store_id
          AND u.fnsku IS NOT NULL AND p.fnsku = u.fnsku AND p.deleted_at IS NULL
        UNION ALL
        SELECT 'products.exact_sku', p.id
        FROM public.products p
        WHERE p.organization_id = u.organization_id AND p.store_id = u.store_id
          AND u.sku IS NOT NULL AND p.sku = u.sku AND p.deleted_at IS NULL
          AND (u.asin IS NULL OR p.asin = u.asin)
        UNION ALL
        SELECT 'products.exact_sku_asin', p.id
        FROM public.products p
        WHERE p.organization_id = u.organization_id AND p.store_id = u.store_id
          AND u.sku IS NOT NULL AND u.asin IS NOT NULL
          AND p.sku = u.sku AND p.asin = u.asin AND p.deleted_at IS NULL
        UNION ALL
        SELECT 'products.exact_upc', p.id
        FROM public.products p
        WHERE p.organization_id = u.organization_id AND p.store_id = u.store_id
          AND u.upc IS NOT NULL AND (p.upc_code = u.upc OR p.barcode = u.upc) AND p.deleted_at IS NULL
        UNION ALL
        SELECT 'inventory.exact_fnsku', COALESCE(a.resolved_product_id, a.product_id)
        FROM public.amazon_amazon_fulfilled_inventory a
        WHERE a.organization_id = u.organization_id AND a.store_id = u.store_id
          AND u.fnsku IS NOT NULL AND a.fulfillment_channel_sku = u.fnsku
          AND COALESCE(a.resolved_product_id, a.product_id) IS NOT NULL
        UNION ALL
        SELECT 'inventory.exact_fnsku', COALESCE(f.resolved_product_id, f.product_id)
        FROM public.amazon_fba_inventory f
        WHERE f.organization_id = u.organization_id AND f.store_id = u.store_id
          AND u.fnsku IS NOT NULL AND f.fnsku = u.fnsku
          AND COALESCE(f.resolved_product_id, f.product_id) IS NOT NULL
        UNION ALL
        SELECT 'inventory.exact_fnsku', COALESCE(mf.resolved_product_id, mf.product_id)
        FROM public.amazon_manage_fba_inventory mf
        WHERE mf.organization_id = u.organization_id AND mf.store_id = u.store_id
          AND u.fnsku IS NOT NULL AND mf.fnsku = u.fnsku
          AND COALESCE(mf.resolved_product_id, mf.product_id) IS NOT NULL
        UNION ALL
        SELECT 'inventory.exact_sku', COALESCE(a.resolved_product_id, a.product_id)
        FROM public.amazon_amazon_fulfilled_inventory a
        WHERE a.organization_id = u.organization_id AND a.store_id = u.store_id
          AND u.sku IS NOT NULL AND a.seller_sku = u.sku
          AND COALESCE(a.resolved_product_id, a.product_id) IS NOT NULL
        UNION ALL
        SELECT 'inventory.exact_sku', COALESCE(f.resolved_product_id, f.product_id)
        FROM public.amazon_fba_inventory f
        WHERE f.organization_id = u.organization_id AND f.store_id = u.store_id
          AND u.sku IS NOT NULL AND f.sku = u.sku
          AND COALESCE(f.resolved_product_id, f.product_id) IS NOT NULL
        UNION ALL
        SELECT 'inventory.exact_sku', COALESCE(mf.resolved_product_id, mf.product_id)
        FROM public.amazon_manage_fba_inventory mf
        WHERE mf.organization_id = u.organization_id AND mf.store_id = u.store_id
          AND u.sku IS NOT NULL AND mf.sku = u.sku
          AND COALESCE(mf.resolved_product_id, mf.product_id) IS NOT NULL
      ) x
      WHERE u.read_bucket IN ('unresolved', 'ambiguous')
    ),
    proof_agg AS (
      SELECT row_id,
        COUNT(DISTINCT pid)::int AS proof_distinct,
        ARRAY_AGG(DISTINCT pid) AS proof_pids,
        ARRAY_AGG(DISTINCT src) AS proof_sources
      FROM proof
      WHERE pid IS NOT NULL
      GROUP BY row_id
    )
    SELECT u.*,
      COALESCE(pa.proof_distinct, 0) AS proof_distinct,
      COALESCE(pa.proof_pids, ARRAY[]::text[]) AS proof_pids,
      COALESCE(pa.proof_sources, ARRAY[]::text[]) AS proof_sources
    FROM unresolved u
    LEFT JOIN proof_agg pa ON pa.row_id = u.id
    WHERE u.read_bucket IN ('unresolved', 'ambiguous')
  `);
  return r.rows as Record<string, unknown>[];
}

function toCandidate(table: TableName, row: Record<string, unknown>): ExactCandidate {
  const pid = (row.proof_pids as string[])[0]!;
  const actions =
    table === "expected_packages"
      ? ["insert_product_identifier_map"]
      : ["update_resolved_product_id", "insert_product_identifier_map_if_gap"];

  return {
    table,
    row_id: String(row.id),
    organization_id: String(row.organization_id),
    store_id: String(row.store_id),
    sku: row.sku ? String(row.sku) : null,
    fnsku: row.fnsku ? String(row.fnsku) : null,
    asin: row.asin ? String(row.asin) : null,
    upc: row.upc ? String(row.upc) : null,
    recommended_product_id: pid,
    match_via: row.proof_sources as string[],
    proposed_actions: actions,
    map_insert: {
      product_id: pid,
      seller_sku: row.sku ? String(row.sku) : null,
      msku: row.sku ? String(row.sku) : null,
      fnsku: row.fnsku ? String(row.fnsku) : null,
      asin: row.asin ? String(row.asin) : null,
      match_source: MATCH_SOURCE,
    },
  };
}

function writeApproval(
  relPath: string,
  title: string,
  flags: { staging: string; specific: string },
  body: string,
): void {
  const content = `# ${title}

**Default:** not approved.

| Field | Value |
|-------|--------|
| Staging ref | \`${STAGING_REF}\` |
| Production / original | forbidden |
| Product creation | forbidden |

\`\`\`text
APPROVED_TO_RUN_STAGING=false
${flags.specific}=false
\`\`\`

${body}

## Sign-off

\`\`\`
APPROVED_TO_RUN_STAGING=false
${flags.specific}=false
Approved by:
UTC date:
\`\`\`
`;
  fs.writeFileSync(path.join(process.cwd(), relPath), content);
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
  if (!url || refFromSupabaseUrl(url) !== STAGING_REF) throw new Error("Supabase guard failed");

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '180s'");

  const tables: TableName[] = ["expected_packages", "return_items", "slip_contents"];
  const coverageByTable: Record<string, Record<string, number>> = {};
  const candidates: ExactCandidate[] = [];
  const exclusions: Exclusion[] = [];
  let epDirtyCount = 0;

  for (const table of tables) {
    coverageByTable[table] = await coverage(client, table);
    const rows = await fetchUnresolvedWithProofs(client, table);

    for (const r of rows) {
      const base = {
        table,
        row_id: String(r.id),
        sku: r.sku ? String(r.sku) : null,
        fnsku: r.fnsku ? String(r.fnsku) : null,
        store_id: r.store_id ? String(r.store_id) : null,
      };
      const proofPids = Array.isArray(r.proof_pids) ? (r.proof_pids as string[]) : [];
      const proofSources = Array.isArray(r.proof_sources) ? (r.proof_sources as string[]) : [];
      const readBucket = String(r.read_bucket);
      const mapIds = Array.isArray(r.map_product_ids) ? [...new Set(r.map_product_ids as string[])] : [];

      if (isDirty(base)) {
        if (table === "expected_packages") epDirtyCount++;
        exclusions.push({
          table,
          row_id: base.row_id,
          reason: "invalid_test_dirty",
          sku: base.sku,
          fnsku: base.fnsku,
          proof_product_ids: proofPids,
          proof_sources: proofSources,
        });
        continue;
      }

      if (readBucket === "ambiguous" || mapIds.length > 1) {
        exclusions.push({
          table,
          row_id: base.row_id,
          reason: "ambiguous_map",
          sku: base.sku,
          fnsku: base.fnsku,
          proof_product_ids: mapIds.length ? mapIds : proofPids,
          proof_sources: proofSources,
        });
        continue;
      }

      if (!base.sku && !base.fnsku && !r.asin && !r.upc) {
        exclusions.push({
          table,
          row_id: base.row_id,
          reason: "missing_identifiers",
          sku: base.sku,
          fnsku: base.fnsku,
          proof_product_ids: proofPids,
          proof_sources: proofSources,
        });
        continue;
      }

      const proofDistinct = Number(r.proof_distinct ?? 0);
      if (proofDistinct === 0) {
        exclusions.push({
          table,
          row_id: base.row_id,
          reason: "no_exact_product_proof",
          sku: base.sku,
          fnsku: base.fnsku,
          proof_product_ids: [],
          proof_sources: [],
        });
        continue;
      }

      if (proofDistinct > 1) {
        exclusions.push({
          table,
          row_id: base.row_id,
          reason: "ambiguous_exact_proofs",
          sku: base.sku,
          fnsku: base.fnsku,
          proof_product_ids: proofPids,
          proof_sources: proofSources,
        });
        continue;
      }

      const legacyProductId = r.product_id ? String(r.product_id) : null;
      const singlePid = proofPids[0]!;
      if (legacyProductId && legacyProductId !== singlePid) {
        exclusions.push({
          table,
          row_id: base.row_id,
          reason: "legacy_product_id_mismatch",
          sku: base.sku,
          fnsku: base.fnsku,
          proof_product_ids: proofPids,
          proof_sources: proofSources,
        });
        continue;
      }

      candidates.push(toCandidate(table, r));
    }
  }
  await client.end();

  const epCandidates = candidates.filter((c) => c.table === "expected_packages");
  const riCandidates = candidates.filter((c) => c.table === "return_items");
  const scCandidates = candidates.filter((c) => c.table === "slip_contents");

  const coverageMd = [
    "# Recomputed coverage (staging)",
    "",
    `**Run id:** \`${runId}\``,
    `**Branch:** \`${branch}\``,
    "",
    "| Table | Total | Resolved | Unresolved | Ambiguous | Missing IDs |",
    "|-------|------:|---------:|-----------:|----------:|------------:|",
    ...tables.map((t) => {
      const c = coverageByTable[t]!;
      return `| ${t} | ${c.total} | ${c.read_layer_resolved} | ${c.unresolved} | ${c.ambiguous} | ${c.missing_identifiers} |`;
    }),
    "",
    "## Exact map-only candidates",
    "",
    `- expected_packages: **${epCandidates.length}**`,
    `- return_items: **${riCandidates.length}**`,
    `- slip_contents: **${scCandidates.length}**`,
    `- expected_packages dirty (source-fix cohort): **${epDirtyCount}**`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "recomputed-coverage.md"), coverageMd);

  fs.writeFileSync(
    path.join(outDir, "exact-map-only-candidates.json"),
    JSON.stringify(
      {
        run_id: runId,
        staging_ref: STAGING_REF,
        match_source: MATCH_SOURCE,
        criteria: [
          "existing product in products or inventory spine",
          "exact identifier match only",
          "single distinct product_id across all proofs",
          "no fuzzy/title/OCR",
        ],
        counts: {
          expected_packages: epCandidates.length,
          return_items: riCandidates.length,
          slip_contents: scCandidates.length,
        },
        candidates: {
          expected_packages: epCandidates,
          return_items: riCandidates,
          slip_contents: scCandidates,
        },
      },
      null,
      2,
    ),
  );

  const byReason = new Map<string, number>();
  for (const e of exclusions) byReason.set(e.reason, (byReason.get(e.reason) ?? 0) + 1);

  const ambiguousMd = [
    "# Ambiguous and non-candidate exclusions",
    "",
    "## Summary by reason",
    "",
    ...[...byReason.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `- **${k}:** ${n}`),
    "",
    "## Sample rows (first 80)",
    "",
    "| table | row_id | reason | fnsku | sku | proof_pids |",
    "|-------|--------|--------|-------|-----|------------|",
    ...exclusions.slice(0, 80).map(
      (e) =>
        `| ${e.table} | \`${e.row_id}\` | ${e.reason} | ${e.fnsku ?? "—"} | ${e.sku ?? "—"} | ${e.proof_product_ids.join(", ") || "—"} |`,
    ),
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "ambiguous-exclusions.md"), `${ambiguousMd}\n`);

  writeApproval(
    APPROVAL_RETURN,
    "PC03A return_items map-only backfill",
    {
      staging: "APPROVED_TO_RUN_STAGING",
      specific: "APPROVED_PC03A_RETURN_ITEMS_MAP_ONLY_BACKFILL",
    },
    `## Scope

- Allowed write: UPDATE \`return_items.resolved_product_id\` (+ optional \`product_identifier_map\` gap fill) for **${riCandidates.length}** approved rows
- Plan: \`${OUT_BASE}/${runId}/exact-map-only-candidates.json\`

## Preconditions

- [ ] Exact-map-only candidates reviewed (${riCandidates.length} rows)
- [ ] No product creation`,
  );

  writeApproval(
    APPROVAL_SLIP,
    "PC03A slip_contents map-only backfill",
    {
      staging: "APPROVED_TO_RUN_STAGING",
      specific: "APPROVED_PC03A_SLIP_CONTENTS_MAP_ONLY_BACKFILL",
    },
    `## Scope

- Allowed write: UPDATE \`slip_contents.resolved_product_id\` (+ optional \`product_identifier_map\` gap fill) for **${scCandidates.length}** approved rows
- Plan: \`${OUT_BASE}/${runId}/exact-map-only-candidates.json\`

## Preconditions

- [ ] Exact-map-only candidates reviewed (${scCandidates.length} rows)
- [ ] No product creation`,
  );

  writeApproval(
    APPROVAL_EP_SOURCE,
    "PC03A expected_packages source identifier fix",
    {
      staging: "APPROVED_TO_RUN_STAGING",
      specific: "APPROVED_PC03A_EXPECTED_PACKAGES_SOURCE_FIX",
    },
    `## Scope

- **Dirty source-fix cohort:** ${epDirtyCount} rows (\`UNKNOW\` SKU, ASIN stored in \`fnsku\`, etc.)
- **Exact map-only (clean):** ${epCandidates.length} rows → \`product_identifier_map\` insert only (read-layer; no \`expected_packages\` bulk update)
- Plan: \`${OUT_BASE}/${runId}/\`

## Preconditions

- [ ] Operator confirms corrected \`sku\`/\`fnsku\` values per dirty row before any map wave
- [ ] Map-only inserts only for rows in \`exact-map-only-candidates.json\` expected_packages section
- [ ] No product creation`,
  );

  fs.writeFileSync(
    path.join(outDir, "approval-files.md"),
    [
      "# Approval files",
      "",
      "| File | Purpose | Default | Candidates |",
      "|------|---------|---------|------------|",
      `| \`${APPROVAL_RETURN}\` | return_items backfill | false | ${riCandidates.length} |`,
      `| \`${APPROVAL_SLIP}\` | slip_contents backfill | false | ${scCandidates.length} |`,
      `| \`${APPROVAL_EP_SOURCE}\` | EP source fix + map-only | false | dirty ${epDirtyCount}, map ${epCandidates.length} |`,
    ].join("\n") + "\n",
  );

  const nextPrompt =
    epDirtyCount > 0
      ? "PC03B-EP — EXPECTED-PACKAGES-DIRTY-SOURCE-QUARANTINE-PLAN"
      : riCandidates.length > 0
        ? "PC03A-EXEC — RETURN-ITEMS-MAP-ONLY-BACKFILL-EXECUTE"
        : scCandidates.length > 0
          ? "PC03A-EXEC — SLIP-CONTENTS-MAP-ONLY-BACKFILL-EXECUTE"
          : epCandidates.length > 0
            ? "PC03A-EXEC — EXPECTED-PACKAGES-MAP-ONLY-INSERT-EXECUTE"
            : "PC03 — EXPECTED-PACKAGES-DIRTY-SOURCE-QUARANTINE-PLAN";

  fs.writeFileSync(
    path.join(outDir, "execute-prompts-next.md"),
    [
      "# Execute prompts (next, in order)",
      "",
      `1. **PC03 — EXPECTED-PACKAGES-DIRTY-SOURCE-QUARANTINE-PLAN** — ${epDirtyCount} dirty EP rows (blocks map/API)`,
      epCandidates.length > 0
        ? `2. **PC03A-EXEC — EXPECTED-PACKAGES-MAP-ONLY-INSERT-EXECUTE** — ${epCandidates.length} clean EP rows after approval \`${APPROVAL_EP_SOURCE}\``
        : "2. *(skip)* No clean expected_packages map-only candidates",
      riCandidates.length > 0
        ? `3. **PC03A-EXEC — RETURN-ITEMS-MAP-ONLY-BACKFILL-EXECUTE** — ${riCandidates.length} rows; approval \`${APPROVAL_RETURN}\``
        : "3. *(skip)* No return_items map-only candidates",
      scCandidates.length > 0
        ? `4. **PC03A-EXEC — SLIP-CONTENTS-MAP-ONLY-BACKFILL-EXECUTE** — ${scCandidates.length} rows; approval \`${APPROVAL_SLIP}\``
        : "4. *(skip)* No slip_contents map-only candidates",
      "",
      `**Recommended next:** \`${nextPrompt}\``,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    [
      "# Blockers",
      "",
      "- Read-only plan; no writes executed.",
      `- **${epDirtyCount}** expected_packages rows have dirty identifiers — must source-fix before map/API.`,
      `- Exact map-only candidates total **${candidates.length}** (EP ${epCandidates.length}, RI ${riCandidates.length}, SC ${scCandidates.length}).`,
      "- All approval files default **false**.",
      "- No fuzzy/title/OCR matching used in candidate selection.",
    ].join("\n") + "\n",
  );

  const manifest = {
    prompt: "PC03A — EXPECTED / RETURN / SLIP MAP-ONLY EXECUTE PLAN",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    status: "PASS",
    output_dir: `${OUT_BASE}/${runId}`,
    coverage: coverageByTable,
    exact_map_only_counts: {
      expected_packages: epCandidates.length,
      return_items: riCandidates.length,
      slip_contents: scCandidates.length,
    },
    expected_packages_dirty_source_fix: epDirtyCount,
    exclusion_count: exclusions.length,
    approval_files: [APPROVAL_RETURN, APPROVAL_SLIP, APPROVAL_EP_SOURCE],
    safest_execute_prompt: nextPrompt,
    forbidden: { db_writes: false, product_create: false, amazon_api: false, fuzzy_match: false },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
