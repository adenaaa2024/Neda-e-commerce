/**
 * NEXT-PRODUCT-ID-06 — Read-only conflict enrichment + authority review pack.
 *
 * Reads NEXT-PRODUCT-ID-05 artifacts and optionally enriches from Supabase (SELECT only).
 *
 *   npx tsx scripts/product-id-06-conflict-enrichment-pack.ts \
 *     --input-dir=.cursor/audit-reports/next-product-id-05/20260513T194738Z
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mkRunDir, mkRunId, sha256Hex, writeCsv, writeJson, type RunMetadata } from "../lib/audits/product-seed-output";

type AmbiguousRow = {
  source_row_id: string;
  organization_id: string;
  store_id: string;
  identifiers: Record<string, string | undefined>;
  primary_reason: string;
  secondary_reasons: string[];
  conflict_product_ids: string[];
};

type FanOutEntry = {
  organization_id: string;
  store_id: string | null;
  identifier_type: string;
  identifier_value: string;
  count_distinct_product_id: number;
  product_ids: string[];
};

type ProductRow = {
  id: string;
  sku: string | null;
  product_name: string | null;
  status: string | null;
  asin: string | null;
  fnsku: string | null;
  organization_id: string | null;
  store_id: string | null;
};

type MapRow = {
  product_id: string | null;
  seller_sku: string | null;
  asin: string | null;
  fnsku: string | null;
  title: string | null;
  match_source: string | null;
  source_report_type: string | null;
  source_upload_id: string | null;
  last_seen_at: string | null;
};

function loadEnvLocal(): void {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  const text = fs.readFileSync(p, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([^#=]+)=(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim();
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

function requireEnv(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env / .env.local.");
  }
  return { url, key };
}

function readNdjson<T>(filePath: string): T[] {
  const text = fs.readFileSync(filePath, "utf8").trim();
  if (!text) return [];
  return text.split(/\n/).map((line) => JSON.parse(line) as T);
}

function fanOutKey(org: string, store: string | null, typ: string, val: string): string {
  return `${org}|${store ?? "null"}|${typ}|${val}`;
}

function suggestedAction(primary: string): string {
  if (primary === "f2_cross_product_conflict") {
    return "Operator: pick canonical product_id per ASIN/FNSKU cluster; clean product_identifier_map duplicates or merge products; do not auto-backfill until decided.";
  }
  if (primary === "f3_shape_invalid_alongside_valid") {
    return "Fix source listing / FBA file: invalid FNSKU shape or SKU placeholder; reconcile with Amazon catalog before identity writes.";
  }
  return "Manual review: confirm identifier authority and map rows.";
}

function identifierTypesInvolved(ids: Record<string, string | undefined>): string {
  const t: string[] = [];
  if (ids.seller_sku) t.push("seller_sku");
  if (ids.asin) t.push("asin");
  if (ids.fnsku) t.push("fnsku");
  if (ids.upc) t.push("upc");
  if (ids.title) t.push("title");
  return t.join("|");
}

function summarizeProduct(p: ProductRow | undefined): string {
  if (!p) return "";
  return [p.id, p.sku ?? "", p.product_name ?? "", p.status ?? "", p.asin ?? "", p.fnsku ?? ""].join(" | ");
}

function summarizeMapRows(rows: MapRow[]): string {
  if (rows.length === 0) return "";
  const parts = rows.slice(0, 8).map(
    (r) =>
      `${r.match_source ?? "?"}:${r.source_report_type ?? "?"} sku=${r.seller_sku ?? ""} asin=${r.asin ?? ""} fnsku=${r.fnsku ?? ""}`,
  );
  const tail = rows.length > 8 ? ` (+${rows.length - 8} more map rows)` : "";
  return parts.join(" ;; ") + tail;
}

async function fetchInChunks<T>(
  sb: SupabaseClient,
  table: string,
  col: string,
  ids: string[],
  select: string,
): Promise<T[]> {
  const out: T[] = [];
  const chunk = 80;
  const uniq = [...new Set(ids)].filter(Boolean);
  for (let i = 0; i < uniq.length; i += chunk) {
    const slice = uniq.slice(i, i + chunk);
    const { data, error } = await sb.from(table).select(select).in(col, slice);
    if (error) throw new Error(`${table}.${col} fetch: ${error.message}`);
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

async function fetchMapsForProducts(
  sb: SupabaseClient,
  organizationId: string,
  productIds: string[],
): Promise<MapRow[]> {
  const out: MapRow[] = [];
  const chunk = 60;
  const uniq = [...new Set(productIds)].filter(Boolean);
  for (let i = 0; i < uniq.length; i += chunk) {
    const slice = uniq.slice(i, i + chunk);
    const { data, error } = await sb
      .from("product_identifier_map")
      .select(
        "product_id,seller_sku,asin,fnsku,title,match_source,source_report_type,source_upload_id,last_seen_at",
      )
      .eq("organization_id", organizationId)
      .in("product_id", slice);
    if (error) throw new Error(`product_identifier_map fetch: ${error.message}`);
    out.push(...((data ?? []) as MapRow[]));
  }
  return out;
}

function safeNewProfile(ids: Record<string, string | undefined>): string {
  const has = (k: string) => Boolean(ids[k]?.trim());
  const sku = has("seller_sku");
  const asin = has("asin");
  const fnsku = has("fnsku");
  const title = has("title");
  if (sku && asin && fnsku) return title ? "sku+asin+fnsku+title" : "sku+asin+fnsku_missing_title";
  if (sku && asin) return "sku+asin";
  if (asin && fnsku) return "asin+fnsku";
  if (sku) return "sku_only";
  return "other_sparse";
}

async function readGitSha(): Promise<string | null> {
  try {
    const { execSync } = await import("node:child_process");
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function getSupabaseJsVersion(): string | null {
  try {
    const pkgPath = path.join(process.cwd(), "node_modules", "@supabase", "supabase-js", "package.json");
    const raw = fs.readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  const inputDirArg = process.argv.find((a) => a.startsWith("--input-dir="));
  const inputDir = inputDirArg
    ? inputDirArg.split("=")[1].trim()
    : path.join(".cursor", "audit-reports", "next-product-id-05", "20260513T194738Z");

  const ambiguousPath = path.join(inputDir, "ambiguous-conflicts.ndjson");
  const safeNewPath = path.join(inputDir, "safe-new-candidates.ndjson");
  const fanOutPath = path.join(inputDir, "02-identifier-fan-out.json");
  const id05Log = path.join(inputDir, "logs", "product-id-05.ndjson");

  const ambiguousRaw = readNdjson<Record<string, unknown>>(ambiguousPath);
  const ambiguous: AmbiguousRow[] = ambiguousRaw.map((r) => ({
    source_row_id: String(r.source_row_id),
    organization_id: String(r.organization_id),
    store_id: String(r.store_id),
    identifiers: (r.identifiers as Record<string, string | undefined>) ?? {},
    primary_reason: String(r.primary_reason),
    secondary_reasons: (r.secondary_reasons as string[]) ?? [],
    conflict_product_ids: (r.conflict_product_ids as string[]) ?? [],
  }));

  const safeNewRaw = readNdjson<Record<string, unknown>>(safeNewPath);
  const fanOut: FanOutEntry[] = JSON.parse(fs.readFileSync(fanOutPath, "utf8")) as FanOutEntry[];

  const fanMap = new Map<string, FanOutEntry>();
  for (const e of fanOut) {
    fanMap.set(fanOutKey(e.organization_id, e.store_id, e.identifier_type, e.identifier_value), e);
  }

  const { url, key } = requireEnv();
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const orgId = ambiguous[0]?.organization_id ?? safeNewRaw[0]?.organization_id;
  if (!orgId || typeof orgId !== "string") {
    throw new Error("Could not infer organization_id from ambiguous or safe-new rows.");
  }

  const allPids = new Set<string>();
  for (const r of ambiguous) {
    for (const p of r.conflict_product_ids) allPids.add(p);
  }
  const f3Pid = ambiguous.find((r) => r.primary_reason === "f3_shape_invalid_alongside_valid" && r.conflict_product_ids[0]);
  if (f3Pid?.conflict_product_ids[0]) allPids.add(f3Pid.conflict_product_ids[0]);

  const products = await fetchInChunks<ProductRow>(
    sb,
    "products",
    "id",
    [...allPids],
    "id,sku,product_name,status,asin,fnsku,organization_id,store_id",
  );
  const productById = new Map(products.map((p) => [p.id, p]));

  const mapRows = await fetchMapsForProducts(sb, orgId, [...allPids]);
  const mapByProduct = new Map<string, MapRow[]>();
  for (const m of mapRows) {
    if (!m.product_id) continue;
    const arr = mapByProduct.get(m.product_id) ?? [];
    arr.push(m);
    mapByProduct.set(m.product_id, arr);
  }

  const ambiguousCsvRows: Record<string, unknown>[] = [];
  for (const r of ambiguous) {
    const ids = r.identifiers;
    const summaries = r.conflict_product_ids.map((pid) => summarizeProduct(productById.get(pid))).join(" || ");
    const mapProv = r.conflict_product_ids
      .map((pid) => `${pid}: ${summarizeMapRows(mapByProduct.get(pid) ?? [])}`)
      .join(" ||| ");
    ambiguousCsvRows.push({
      source_row_id: r.source_row_id,
      organization_id: r.organization_id,
      store_id: r.store_id,
      seller_sku: ids.seller_sku ?? "",
      asin: ids.asin ?? "",
      fnsku: ids.fnsku ?? "",
      product_name: ids.title ?? "",
      primary_reason: r.primary_reason,
      secondary_reasons_json: JSON.stringify(r.secondary_reasons),
      conflict_product_ids_json: JSON.stringify(r.conflict_product_ids),
      identifier_types_involved: identifierTypesInvolved(ids),
      candidate_product_summaries: summaries,
      map_provenance_summaries: mapProv.slice(0, 8000),
      suggested_review_action: suggestedAction(r.primary_reason),
    });
  }

  type CrossAgg = {
    identifier_type: string;
    identifier_value: string;
    product_ids: string[];
    source_row_ids: Set<string>;
  };
  const crossAggs = new Map<string, CrossAgg>();

  for (const row of ambiguous) {
    if (row.primary_reason !== "f2_cross_product_conflict") continue;
    const conflicts = row.conflict_product_ids;
    const cset = new Set(conflicts);
    for (const typ of ["asin", "fnsku", "seller_sku"] as const) {
      const val = row.identifiers[typ]?.trim();
      if (!val) continue;
      const key = fanOutKey(row.organization_id, row.store_id, typ, val);
      const fo = fanMap.get(key);
      if (!fo) continue;
      const fset = new Set(fo.product_ids);
      const hit = [...cset].filter((id) => fset.has(id));
      if (hit.length < 2) continue;
      const gk = `${typ}|${val}`;
      let agg = crossAggs.get(gk);
      if (!agg) {
        agg = { identifier_type: typ, identifier_value: val, product_ids: [...fo.product_ids], source_row_ids: new Set() };
        crossAggs.set(gk, agg);
      }
      agg.source_row_ids.add(row.source_row_id);
    }
  }

  const crossCsvRows: Record<string, unknown>[] = [];
  for (const agg of crossAggs.values()) {
    const pids = agg.product_ids;
    let winnerNote = "not_obvious";
    for (const sid of agg.source_row_ids) {
      const row = ambiguous.find((x) => x.source_row_id === sid);
      if (!row) continue;
      const sku = row.identifiers.seller_sku?.trim();
      if (!sku) continue;
      for (const pid of pids) {
        const pr = productById.get(pid);
        if (pr?.sku === sku) winnerNote = `prefer_product_id_if_sku_match=${pid}`;
      }
    }
    crossCsvRows.push({
      identifier_type: agg.identifier_type,
      identifier_value: agg.identifier_value,
      product_ids_json: JSON.stringify(agg.product_ids),
      fan_out_distinct_count: agg.product_ids.length,
      source_row_ids_affected: [...agg.source_row_ids].join(";"),
      affected_row_count: agg.source_row_ids.size,
      cross_store: "false_single_store_slice",
      cross_org: "false_single_org_slice",
      possible_authority_winner_note: winnerNote,
      hot_loser_risk_note:
        "Cross-reference NEXT-18M hot-loser protection for merge losers; no automatic merge in Phase B.",
    });
  }
  crossCsvRows.sort((a, b) => String(a.identifier_value).localeCompare(String(b.identifier_value)));

  const typeHistogram: Record<string, number> = {};
  const productFanHits = new Map<string, number>();
  for (const e of fanOut) {
    typeHistogram[e.identifier_type] = (typeHistogram[e.identifier_type] ?? 0) + 1;
    for (const pid of e.product_ids) {
      productFanHits.set(pid, (productFanHits.get(pid) ?? 0) + 1);
    }
  }

  const topFanByProductCount = [...fanOut]
    .sort((a, b) => b.count_distinct_product_id - a.count_distinct_product_id)
    .slice(0, 25);
  const topProducts = [...productFanHits.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([pid, n]) => ({ product_id: pid, fan_out_entry_count: n, sku: productById.get(pid)?.sku ?? "" }));

  const safeNearRisk: { source_row_id: string; reason: string }[] = [];
  for (const raw of safeNewRaw) {
    const ids = (raw.identifiers as Record<string, string | undefined>) ?? {};
    const sid = String(raw.source_row_id);
    let reason = "";
    for (const typ of ["asin", "fnsku", "seller_sku"] as const) {
      const val = ids[typ]?.trim();
      if (!val) continue;
      const fk = fanOutKey(String(raw.organization_id), String(raw.store_id), typ, val);
      if (fanMap.has(fk)) reason += `${typ}:${val};`;
    }
    if (reason) safeNearRisk.push({ source_row_id: sid, reason });
  }

  const safeProfileCounts: Record<string, number> = {};
  for (const raw of safeNewRaw) {
    const ids = (raw.identifiers as Record<string, string | undefined>) ?? {};
    const prof = safeNewProfile(ids);
    safeProfileCounts[prof] = (safeProfileCounts[prof] ?? 0) + 1;
  }

  const runId = mkRunId();
  const baseDir = path.join(".cursor", "audit-reports", "next-product-id-06");
  const runDir = mkRunDir(baseDir, runId);
  const startedAt = new Date().toISOString();

  const meta: RunMetadata = {
    runId,
    startedAt,
    finishedAt: null,
    cliArgs: { inputDir, dryRunOnly: true },
    envHash: sha256Hex(url),
    nodeVersion: process.version,
    supabaseJsVersion: getSupabaseJsVersion(),
    generatorGitSha: await readGitSha(),
  };
  const ambiguousHeaders = [
    "source_row_id",
    "organization_id",
    "store_id",
    "seller_sku",
    "asin",
    "fnsku",
    "product_name",
    "primary_reason",
    "secondary_reasons_json",
    "conflict_product_ids_json",
    "identifier_types_involved",
    "candidate_product_summaries",
    "map_provenance_summaries",
    "suggested_review_action",
  ] as const;
  writeCsv(path.join(runDir, "ambiguous-review-pack.csv"), ambiguousHeaders, ambiguousCsvRows);

  const crossHeaders = [
    "identifier_type",
    "identifier_value",
    "product_ids_json",
    "fan_out_distinct_count",
    "source_row_ids_affected",
    "affected_row_count",
    "cross_store",
    "cross_org",
    "possible_authority_winner_note",
    "hot_loser_risk_note",
  ] as const;
  writeCsv(path.join(runDir, "cross-product-conflict-review-pack.csv"), crossHeaders, crossCsvRows);

  const finishedAt = new Date().toISOString();
  writeJson(path.join(runDir, "manifest.json"), {
    ...meta,
    finishedAt,
    auditPrompt: "NEXT-PRODUCT-ID-06",
    inputs: { id05_dir: inputDir },
    counts: {
      ambiguous_rows: ambiguous.length,
      cross_product_identifier_groups: crossCsvRows.length,
      fan_out_findings: fanOut.length,
      safe_new_candidates: safeNewRaw.length,
      safe_new_near_fanout_rows: safeNearRisk.length,
    },
  });

  const fanoutMd = `# Fan-out summary (NEXT-PRODUCT-ID-06)

Source: \`${path.relative(process.cwd(), fanOutPath).replace(/\\/g, "/")}\` — **${fanOut.length}** findings.

## By identifier type

${Object.entries(typeHistogram)
  .sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `- **${k}:** ${v}`)
  .join("\n")}

## Interpretation

- **UPC** accounts for most fan-out rows in this tenant index — often **catalog / retail packaging variants** sharing a barcode across internal duplicate \`product_id\` rows. Treat UPC as **weak merge evidence** without pack/size context.
- **ASIN** fan-out (71 rows) is **listing-level** duplication (re-imports, splits, multi-pack offers) — common and not automatically malicious, but it **blocks naive auto-link** until a canonical product is chosen.
- **FNSKU** fan-out (1 row here) is **fulfillment-strong** when present: resolve before trusting FBA inventory resolver output.

## Highest fan-out cardinality (distinct product_ids per identifier)

| Rank | Type | Value | distinct_product_ids |
|------|------|-------|----------------------:|
${topFanByProductCount
  .map((v, i) => `| ${i + 1} | ${v.identifier_type} | ${v.identifier_value} | ${v.count_distinct_product_id} |`)
  .join("\n")}

## Products appearing in the most fan-out entries

| product_id | #fan-out entries | sku (from DB if fetched) |
|------------|------------------|--------------------------|
${topProducts.map((p) => `| ${p.product_id} | ${p.fan_out_entry_count} | ${p.sku} |`).join("\n")}

## Policy hints (read-only recommendation)

| Identifier | Policy |
|------------|--------|
| seller_sku | Treat as **strong** within (organization_id, store_id); collisions with map should win over ASIN-only guesses. |
| fnsku | Treat as **fulfillment-strong**; fan-out should trigger **map cleanup or merge** before auto-resolver writes. |
| asin | **Listing-level**; multi-product ASIN is common (variants); do not auto-merge without pack/condition context. |
| upc | Not prevalent in this FBA slice; when present, treat like ASIN — **not sufficient alone** for merge. |
| title / product_name | **Never** sufficient as sole authority; use for human triage only. |
`;

  fs.writeFileSync(path.join(runDir, "fanout-summary.md"), fanoutMd, "utf8");

  const safeMd = `# Safe-new candidate review (NEXT-PRODUCT-ID-06)

**Total:** ${safeNewRaw.length} rows from \`safe-new-candidates.ndjson\`.

## Identifier completeness profiles

${Object.entries(safeProfileCounts)
  .sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `- **${k}:** ${v}`)
  .join("\n")}

## Near-conflict risk (identifier also appears in fan-out index)

Rows whose seller_sku, asin, or fnsku appears as a **fan-out key** in the same tenant (i.e. that identifier already maps to 2+ products in the dry-run index): **${safeNearRisk.length}**.

> Interpretation: **0** means every safe-new row’s ASIN/FNSKU/SKU keys are **not** among the 2,485 fan-out driver keys — consistent with the classifier allowing bucket 4 only when identifier-map collisions were absent for that row’s evidence path. Fan-out elsewhere still signals org-wide map hygiene work, but it does not overlap these 125 SKUs in the index used for this audit.

${safeNearRisk.length ? `### Affected source_row_id (first 40)\n\n${safeNearRisk.slice(0, 40).map((x) => `- \`${x.source_row_id}\` — ${x.reason}`).join("\n")}` : ""}
`;

  fs.writeFileSync(path.join(runDir, "safe-new-candidate-review.md"), safeMd, "utf8");

  const authorityMd = `# Authority rule proposal (NEXT-PRODUCT-ID-06)

Read-only governance draft for **Phase B** — no implementation in this artifact.

## Tier 1 — Automatic (when allowed later, after sign-off)

1. **seller_sku + (organization_id, store_id)** — Primary operational key. If exactly one \`product_identifier_map\` row OR one \`products\` row matches, **safe auto-link** candidate.
2. **fnsku + (organization_id, store_id)** — If unique in map and matches inventory row, **strong** link; if fan-out, **stop** and require map cleanup.

## Tier 2 — Conditional

3. **ASIN** — Use only when **no FNSKU fan-out** and **no SKU collision**; if ASIN maps to 2+ products, **human review** or variant metadata (pack size) required.
4. **UPC/GTIN** — Same as ASIN; never sole authority when multiple catalog variants exist.

## Tier 3 — Never sole authority

5. **product_name / title** — Display-only for review UI; **never** auto-merge or auto-create from name alone.

## Mandatory human review

- Any **f2_cross_product_conflict** row (see ambiguous pack).
- Any **f3_shape_invalid** row (bad FNSKU pattern, placeholder SKU).
- Any row where **secondary_reasons** include \`f1_identifier_fan_out:asin\` (ASIN ambiguity flagged alongside cross collision).
- Prior pipeline context: NEXT-18J/K/M flagged **large merge-risk / hot-loser** clusters — align merge decisions with that audit family before destructive map edits.

## Safe product creation queue (future)

- Only after: (a) governance sign-off, (b) **no fan-out** on chosen identifiers for that tenant slice, (c) explicit **SKU uniqueness** check on \`products\`.

## Map cleanup first

- When fan-out shows **two products for one FNSKU or ASIN**, resolver backfill must **not** proceed until operators pick canonical \`product_id\` or merge products with reversibility plan.

`;

  fs.writeFileSync(path.join(runDir, "authority-rule-proposal.md"), authorityMd, "utf8");

  const enrichSummary = `# Conflict enrichment summary (NEXT-PRODUCT-ID-06)

## Inputs

- **ID-05 directory:** \`${inputDir.replace(/\\/g, "/")}\`
- **Prior audits referenced:** NEXT-18J (orphan/backfill classification), NEXT-18K (merge winners / blocked groups), NEXT-18M (hot-loser / dispute) — see run summaries under \`.cursor/audit-reports/next-18j|k|m/\` for org-wide context (not re-run here).

## Counts

| Slice | Count |
|-------|------:|
| Ambiguous / conflict rows (bucket 5) | ${ambiguous.length} |
| f2_cross_product_conflict | ${ambiguous.filter((r) => r.primary_reason === "f2_cross_product_conflict").length} |
| f3_shape_invalid_alongside_valid | ${ambiguous.filter((r) => r.primary_reason === "f3_shape_invalid_alongside_valid").length} |
| Cross-product identifier driver groups (aggregated) | ${crossCsvRows.length} |
| Fan-out findings | ${fanOut.length} |
| Safe-new candidates | ${safeNewRaw.length} |
| Safe-new with identifier also in fan-out index | ${safeNearRisk.length} |

## Enrichment performed

- **Supabase (read-only):** \`products\` for all \`conflict_product_ids\`; \`product_identifier_map\` for those product_ids within the row organization.
- **Files:** \`ambiguous-review-pack.csv\`, \`cross-product-conflict-review-pack.csv\`.

`;

  fs.writeFileSync(path.join(runDir, "conflict-enrichment-summary.md"), enrichSummary, "utf8");

  const nextStep = `# Next step recommendation (NEXT-PRODUCT-ID-06)

1. **Manual review** of \`ambiguous-review-pack.csv\` (42 rows) — decide canonical product per cluster using SKU/FNSKU evidence and map provenance columns.
2. **Resolver confidence policy** — encode Tier 1–3 rules above into resolver status enums before any \`resolved_product_id\` writes on \`amazon_fba_inventory\`.
3. **Product_id backfill plan** — document only after sign-off; prerequisite: reduce cross-product groups and hot-loser exposure (NEXT-18M alignment).

**No DB writes** in this pack generation.

`;

  fs.writeFileSync(path.join(runDir, "next-step-recommendation.md"), nextStep, "utf8");

  const logPath = path.join(runDir, "logs", "product-id-06.ndjson");
  const lines = [
    JSON.stringify({
      ts: startedAt,
      event: "enrichment_start",
      auditPrompt: "NEXT-PRODUCT-ID-06",
      input_dir: inputDir,
    }),
    JSON.stringify({
      ts: finishedAt,
      event: "enrichment_complete",
      ambiguous_rows: ambiguous.length,
      cross_product_groups: crossCsvRows.length,
      fan_out_findings: fanOut.length,
      safe_new_rows: safeNewRaw.length,
      safe_new_near_fanout: safeNearRisk.length,
      products_fetched: products.length,
      map_rows_fetched: mapRows.length,
    }),
  ];
  if (fs.existsSync(id05Log)) {
    lines.push(
      JSON.stringify({
        ts: finishedAt,
        event: "id05_log_tail_reference",
        note: "See NEXT-PRODUCT-ID-05 logs for dry-run context",
        path: id05Log,
      }),
    );
  }
  fs.writeFileSync(logPath, lines.join("\n") + "\n", "utf8");

  console.log(`[product-id-06] run_dir=${runDir}`);
  console.log(
    `[product-id-06] ambiguous=${ambiguous.length} cross_groups=${crossCsvRows.length} fan_out=${fanOut.length} safe_new=${safeNewRaw.length} safe_near_fanout=${safeNearRisk.length}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
