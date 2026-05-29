/**
 * ORIGINAL-PARITY-WAVE-B GOVERNED MAP REPLAY PLAN (read-only)
 *
 * Census unresolved original expected_packages, classify identifier evidence,
 * compare staging governed map history, produce safe replay plan.
 *
 *   npx tsx scripts/original-parity-wave-b-governed-map-replay-plan.ts --run-id=<UTC_Z>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const SAM_ORG = "00000000-0000-0000-0000-000000000001";
const SAM_STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/original-parity-wave-b-governed-map-replay-plan";
const APPROVAL_PATH =
  ".cursor/operator-approvals/original-parity-wave-b-governed-map-replay-approval.md";

const GOVERNED_MATCH_SOURCES = [
  "expected_packages_e1_map_bridge_v192",
  "expected_packages_e2_product_promotion_v194",
  "expected_packages_e1b_map_bridge_v198",
  "expected_packages_e1b_blocker_materialize_v200",
  "expected_packages_pc03b_source_disagreement_map",
  "expected_packages_pc03exec_dirty_source_map",
  "expected_packages_pc03c_merge_duplicate_canonical",
  "expected_packages_amazon_api_evidence_v202",
] as const;

const MAP_ONLY_SOURCES = new Set([
  "expected_packages_e1_map_bridge_v192",
  "expected_packages_e1b_map_bridge_v198",
  "expected_packages_pc03b_source_disagreement_map",
  "expected_packages_pc03exec_dirty_source_map",
  "expected_packages_pc03c_merge_duplicate_canonical",
]);

const PRODUCT_CREATE_SOURCES = new Set([
  "expected_packages_e2_product_promotion_v194",
  "expected_packages_e1b_blocker_materialize_v200",
  "expected_packages_amazon_api_evidence_v202",
]);

type UnresolvedEp = {
  id: string;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  upc: string | null;
  build_source: string | null;
  order_id: string | null;
  identifier_resolution_status: string | null;
};

type StagingMapRow = {
  id: string;
  match_source: string;
  product_id: string;
  external_listing_id: string | null;
  seller_sku: string | null;
  msku: string | null;
  fnsku: string | null;
  asin: string | null;
  upc: string | null;
};

type ReplayClass =
  | "safe_map_replay"
  | "product_create_candidate"
  | "conflict"
  | "no_governed_staging_match"
  | "missing_identifiers";

type EpClassification = {
  expected_package_id: string;
  build_source: string | null;
  order_id: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  upc: string | null;
  evidence: {
    has_fnsku: boolean;
    has_sku: boolean;
    has_upc: boolean;
    has_asin: boolean;
    missing_identifiers: boolean;
  };
  classification: ReplayClass;
  staging_match_source: string | null;
  staging_map_id: string | null;
  staging_product_id: string | null;
  match_via: "fnsku" | "sku" | "asin" | "upc" | null;
  reason: string;
};

type SafeMapReplayRow = {
  replay_key: string;
  match_source: string;
  product_id: string;
  external_listing_id: string | null;
  seller_sku: string | null;
  fnsku: string | null;
  asin: string | null;
  upc: string | null;
  match_via: string;
  governed_execute: string;
  map_only: boolean;
  expected_package_ids: string[];
  expected_package_count: number;
};

type ProductCreateCandidate = {
  expected_package_id: string;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  upc: string | null;
  staging_match_source: string;
  staging_product_id: string;
  staging_map_id: string;
  match_via: string;
  reason: string;
  governed_execute: string;
};

type ConflictRow = {
  expected_package_id: string;
  classification: ReplayClass;
  match_via: string | null;
  staging_match_source: string | null;
  staging_product_id: string | null;
  original_product_id: string | null;
  identifier_value: string | null;
  reason: string;
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

function refFromConnectionUrl(url: string): string | null {
  const fromHost = refFromSupabaseUrl(url);
  if (fromHost) return fromHost;
  const m = url.match(/\.([a-z]{20})\./i) ?? url.match(/postgres\.([a-z]{20})/i);
  return m?.[1]?.toLowerCase() ?? null;
}

function n(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function governedExecuteId(matchSource: string): string {
  if (matchSource.includes("e1_map_bridge_v192")) return "E1_V192";
  if (matchSource.includes("e2_product_promotion_v194")) return "E2_V194";
  if (matchSource.includes("e1b_map_bridge_v198")) return "E1B_V198";
  if (matchSource.includes("e1b_blocker_materialize_v200")) return "E1B_V200";
  if (matchSource.includes("pc03b")) return "PC03B";
  if (matchSource.includes("pc03exec")) return "PC03EXEC";
  if (matchSource.includes("pc03c")) return "PC03C";
  if (matchSource.includes("amazon_api_evidence_v202")) return "V202_EVIDENCE";
  return matchSource;
}

function approvalTemplate(runId: string): string {
  return `# Original parity Wave B — governed map replay

**Default:** not approved. Required before governed \`product_identifier_map\` inserts on original.

| Field | Value |
|-------|--------|
| Original ref | \`${ORIGINAL_REF}\` |
| Scope | Deterministic map replay from staging governed executes (E1/E2/E1B/PC03B) |

\`\`\`text
APPROVED_TO_RUN_ORIGINAL=false
APPROVED_ORIGINAL_PARITY_WAVE_B_GOVERNED_MAP_REPLAY=false
\`\`\`

## Sign-off

\`\`\`
APPROVED_TO_RUN_ORIGINAL=false
APPROVED_ORIGINAL_PARITY_WAVE_B_GOVERNED_MAP_REPLAY=false
Approved by:
UTC date:
Plan run_id: ${runId}
\`\`\`
`;
}

async function tableColumns(client: pg.Client, table: string): Promise<Set<string>> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  return new Set((r.rows as Array<{ column_name: string }>).map((x) => x.column_name));
}

async function fetchUnresolvedEp(client: pg.Client, epCols: Set<string>): Promise<UnresolvedEp[]> {
  const asinExpr = epCols.has("asin") ? "NULLIF(TRIM(e.asin), '')" : "NULL::text";
  const upcExpr = epCols.has("upc")
    ? "NULLIF(TRIM(e.upc), '')"
    : epCols.has("upc_code")
      ? "NULLIF(TRIM(e.upc_code), '')"
      : "NULL::text";

  const r = await client.query(
    `
    SELECT
      e.id::text AS id,
      NULLIF(TRIM(e.sku), '') AS sku,
      NULLIF(TRIM(e.fnsku), '') AS fnsku,
      ${asinExpr} AS asin,
      ${upcExpr} AS upc,
      e.build_source,
      NULLIF(TRIM(e.order_id), '') AS order_id,
      e.identifier_resolution_status
    FROM public.expected_packages e
    WHERE e.organization_id = $1::uuid
      AND e.store_id = $2::uuid
      AND e.build_source IN ('detail_shipment', 'detail_remainder')
      AND e.resolved_product_id IS NULL
    ORDER BY e.id
    `,
    [SAM_ORG, SAM_STORE],
  );
  return r.rows as UnresolvedEp[];
}

async function fetchStagingGovernedMaps(
  client: pg.Client,
  mapCols: Set<string>,
): Promise<StagingMapRow[]> {
  const asinSel = mapCols.has("asin") ? "NULLIF(TRIM(m.asin), '')" : "NULL::text";
  const upcSel = mapCols.has("upc") ? "NULLIF(TRIM(m.upc), '')" : "NULL::text";
  const mskuSel = mapCols.has("msku") ? "NULLIF(TRIM(m.msku), '')" : "NULL::text";

  const r = await client.query(
    `
    SELECT
      m.id::text AS id,
      m.match_source,
      m.product_id::text AS product_id,
      m.external_listing_id,
      NULLIF(TRIM(m.seller_sku), '') AS seller_sku,
      ${mskuSel} AS msku,
      NULLIF(TRIM(m.fnsku), '') AS fnsku,
      ${asinSel} AS asin,
      ${upcSel} AS upc
    FROM public.product_identifier_map m
    WHERE m.deleted_at IS NULL
      AND m.organization_id = $1::uuid
      AND m.match_source = ANY($2::text[])
    `,
    [SAM_ORG, [...GOVERNED_MATCH_SOURCES]],
  );
  return r.rows as StagingMapRow[];
}

function buildStagingIndexes(maps: StagingMapRow[]) {
  const byFnsku = new Map<string, StagingMapRow[]>();
  const bySku = new Map<string, StagingMapRow[]>();
  const byAsin = new Map<string, StagingMapRow[]>();
  const byUpc = new Map<string, StagingMapRow[]>();

  const push = (m: Map<string, StagingMapRow[]>, key: string, row: StagingMapRow) => {
    const list = m.get(key) ?? [];
    list.push(row);
    m.set(key, list);
  };

  for (const row of maps) {
    if (row.fnsku) push(byFnsku, row.fnsku.toUpperCase(), row);
    if (row.seller_sku) push(bySku, row.seller_sku.toUpperCase(), row);
    if (row.msku) push(bySku, row.msku.toUpperCase(), row);
    if (row.asin) push(byAsin, row.asin.toUpperCase(), row);
    if (row.upc) push(byUpc, row.upc, row);
  }

  return { byFnsku, bySku, byAsin, byUpc };
}

function pickUniqueGovernedMatch(
  candidates: StagingMapRow[],
): { row: StagingMapRow | null; ambiguous: boolean } {
  if (!candidates.length) return { row: null, ambiguous: false };
  const productIds = new Set(candidates.map((c) => c.product_id));
  if (productIds.size === 1) return { row: candidates[0]!, ambiguous: false };
  return { row: null, ambiguous: true };
}

function buildOrgMapIndexes(
  rows: Array<{
    fnsku: string | null;
    seller_sku: string | null;
    msku: string | null;
    asin: string | null;
    upc: string | null;
    product_id: string;
  }>,
) {
  const fnskuToProduct = new Map<string, string>();
  const skuToProduct = new Map<string, string>();
  const asinToProduct = new Map<string, string>();
  const upcToProduct = new Map<string, string>();

  for (const row of rows) {
    if (row.fnsku) fnskuToProduct.set(row.fnsku.toUpperCase(), row.product_id);
    if (row.seller_sku) skuToProduct.set(row.seller_sku.toUpperCase(), row.product_id);
    if (row.msku) skuToProduct.set(row.msku.toUpperCase(), row.product_id);
    if (row.asin) asinToProduct.set(row.asin.toUpperCase(), row.product_id);
    if (row.upc) upcToProduct.set(row.upc, row.product_id);
  }

  return { fnskuToProduct, skuToProduct, asinToProduct, upcToProduct };
}

function classifyEp(
  ep: UnresolvedEp,
  stagingIdx: ReturnType<typeof buildStagingIndexes>,
  orgProducts: Set<string>,
  orgMapIdx: ReturnType<typeof buildOrgMapIndexes>,
): EpClassification {
  const evidence = {
    has_fnsku: !!ep.fnsku,
    has_sku: !!ep.sku,
    has_upc: !!ep.upc,
    has_asin: !!ep.asin,
    missing_identifiers: !ep.fnsku && !ep.sku && !ep.upc && !ep.asin,
  };

  const base = {
    expected_package_id: ep.id,
    build_source: ep.build_source,
    order_id: ep.order_id,
    sku: ep.sku,
    fnsku: ep.fnsku,
    asin: ep.asin,
    upc: ep.upc,
    evidence,
  };

  if (evidence.missing_identifiers) {
    return {
      ...base,
      classification: "missing_identifiers",
      staging_match_source: null,
      staging_map_id: null,
      staging_product_id: null,
      match_via: null,
      reason: "No FNSKU/SKU/UPC/ASIN on expected_packages row",
    };
  }

  type MatchAttempt = { via: "fnsku" | "sku" | "asin" | "upc"; value: string; rows: StagingMapRow[] };
  const attempts: MatchAttempt[] = [];
  if (ep.fnsku) {
    attempts.push({
      via: "fnsku",
      value: ep.fnsku,
      rows: stagingIdx.byFnsku.get(ep.fnsku.toUpperCase()) ?? [],
    });
  }
  if (ep.sku) {
    attempts.push({
      via: "sku",
      value: ep.sku,
      rows: stagingIdx.bySku.get(ep.sku.toUpperCase()) ?? [],
    });
  }
  if (ep.asin) {
    attempts.push({
      via: "asin",
      value: ep.asin,
      rows: stagingIdx.byAsin.get(ep.asin.toUpperCase()) ?? [],
    });
  }
  if (ep.upc) {
    attempts.push({ via: "upc", value: ep.upc, rows: stagingIdx.byUpc.get(ep.upc) ?? [] });
  }

  let best: {
    via: "fnsku" | "sku" | "asin" | "upc";
    value: string;
    row: StagingMapRow;
  } | null = null;

  for (const attempt of attempts) {
    const { row, ambiguous } = pickUniqueGovernedMatch(attempt.rows);
    if (ambiguous) {
      return {
        ...base,
        classification: "conflict",
        staging_match_source: null,
        staging_map_id: null,
        staging_product_id: null,
        match_via: attempt.via,
        reason: `Ambiguous staging governed map for ${attempt.via}=${attempt.value}`,
      };
    }
    if (row) {
      best = { via: attempt.via, value: attempt.value, row };
      break;
    }
  }

  if (!best) {
    return {
      ...base,
      classification: "no_governed_staging_match",
      staging_match_source: null,
      staging_map_id: null,
      staging_product_id: null,
      match_via: null,
      reason: "Identifiers present but no staging governed map row matches",
    };
  }

  const orgProductId =
    best.via === "fnsku"
      ? orgMapIdx.fnskuToProduct.get(best.value.toUpperCase()) ?? null
      : best.via === "sku"
        ? orgMapIdx.skuToProduct.get(best.value.toUpperCase()) ?? null
        : best.via === "asin"
          ? orgMapIdx.asinToProduct.get(best.value.toUpperCase()) ?? null
          : orgMapIdx.upcToProduct.get(best.value) ?? null;

  if (
    orgProductId &&
    orgProductId !== best.row.product_id
  ) {
    return {
      ...base,
      classification: "conflict",
      staging_match_source: best.row.match_source,
      staging_map_id: best.row.id,
      staging_product_id: best.row.product_id,
      match_via: best.via,
      reason: `Original map resolves ${best.via}=${best.value} to product ${orgProductId}; staging governed row points to ${best.row.product_id}`,
    };
  }

  if (!orgProducts.has(best.row.product_id)) {
    return {
      ...base,
      classification: "product_create_candidate",
      staging_match_source: best.row.match_source,
      staging_map_id: best.row.id,
      staging_product_id: best.row.product_id,
      match_via: best.via,
      reason: `Staging governed map references product ${best.row.product_id} missing on original — requires governed product promotion`,
    };
  }

  if (!MAP_ONLY_SOURCES.has(best.row.match_source)) {
    return {
      ...base,
      classification: "product_create_candidate",
      staging_match_source: best.row.match_source,
      staging_map_id: best.row.id,
      staging_product_id: best.row.product_id,
      match_via: best.via,
      reason: `Match source ${best.row.match_source} includes product creation on staging — replay product+map execute separately`,
    };
  }

  return {
    ...base,
    classification: "safe_map_replay",
    staging_match_source: best.row.match_source,
    staging_map_id: best.row.id,
    staging_product_id: best.row.product_id,
    match_via: best.via,
    reason: `Deterministic map replay via ${best.row.match_source} (${best.via}=${best.value})`,
  };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);

  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!stagingUrl || !originalUrl) {
    blockers.push("Missing STAGING_DIRECT_POSTGRES_URL or ORIGINAL_DIRECT_POSTGRES_URL");
  }
  if (stagingUrl && refFromConnectionUrl(stagingUrl) !== STAGING_REF) {
    blockers.push(`Staging URL must target ${STAGING_REF}`);
  }
  if (originalUrl && refFromConnectionUrl(originalUrl) !== ORIGINAL_REF) {
    blockers.push(`Original URL must target ${ORIGINAL_REF}`);
  }
  if (stagingUrl && originalUrl && stagingUrl === originalUrl) {
    blockers.push("Staging and original URLs must differ");
  }

  let unresolvedCount = 0;
  let evidenceCounts = {
    has_fnsku: 0,
    has_sku: 0,
    has_upc: 0,
    has_asin: 0,
    missing_identifiers: 0,
  };
  let classificationCounts = {
    safe_map_replay: 0,
    product_create_candidate: 0,
    conflict: 0,
    no_governed_staging_match: 0,
    missing_identifiers: 0,
  };
  let safeReplayRows: SafeMapReplayRow[] = [];
  let productCreateCandidates: ProductCreateCandidate[] = [];
  let conflicts: ConflictRow[] = [];
  let governedStagingMapCount = 0;
  let mapStagingActive = 0;
  let mapOriginalActive = 0;

  if (!blockers.length) {
    const staging = new pg.Client({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });
    const original = new pg.Client({ connectionString: originalUrl, ssl: { rejectUnauthorized: false } });
    await staging.connect();
    await original.connect();
    await staging.query("SET statement_timeout = '180s'");
    await original.query("SET statement_timeout = '180s'");

    const epCols = await tableColumns(original, "expected_packages");
    const mapCols = await tableColumns(staging, "product_identifier_map");
    const orgMapCols = await tableColumns(original, "product_identifier_map");

    const unresolved = await fetchUnresolvedEp(original, epCols);
    unresolvedCount = unresolved.length;

    for (const ep of unresolved) {
      if (ep.fnsku) evidenceCounts.has_fnsku++;
      if (ep.sku) evidenceCounts.has_sku++;
      if (ep.upc) evidenceCounts.has_upc++;
      if (ep.asin) evidenceCounts.has_asin++;
      if (!ep.fnsku && !ep.sku && !ep.upc && !ep.asin) evidenceCounts.missing_identifiers++;
    }

    const governedMaps = await fetchStagingGovernedMaps(staging, mapCols);
    governedStagingMapCount = governedMaps.length;
    const stagingIdx = buildStagingIndexes(governedMaps);

    const orgProducts = new Set(
      (
        await original.query(
          `SELECT id::text FROM public.products WHERE deleted_at IS NULL AND organization_id = $1::uuid`,
          [SAM_ORG],
        )
      ).rows.map((r) => (r as { id: string }).id),
    );

    const orgAsinSel = orgMapCols.has("asin") ? "NULLIF(TRIM(m.asin), '')" : "NULL::text";
    const orgUpcSel = orgMapCols.has("upc") ? "NULLIF(TRIM(m.upc), '')" : "NULL::text";
    const orgMskuSel = orgMapCols.has("msku") ? "NULLIF(TRIM(m.msku), '')" : "NULL::text";
    const orgMapRows = (
      await original.query(
        `
        SELECT
          NULLIF(TRIM(m.fnsku), '') AS fnsku,
          NULLIF(TRIM(m.seller_sku), '') AS seller_sku,
          ${orgMskuSel} AS msku,
          ${orgAsinSel} AS asin,
          ${orgUpcSel} AS upc,
          m.product_id::text AS product_id
        FROM public.product_identifier_map m
        WHERE m.deleted_at IS NULL AND m.organization_id = $1::uuid
        `,
        [SAM_ORG],
      )
    ).rows as Array<{
      fnsku: string | null;
      seller_sku: string | null;
      msku: string | null;
      asin: string | null;
      upc: string | null;
      product_id: string;
    }>;
    const orgMapIdx = buildOrgMapIndexes(orgMapRows);

    mapStagingActive = (
      await staging.query(
        `SELECT COUNT(*)::int AS c FROM public.product_identifier_map WHERE deleted_at IS NULL`,
      )
    ).rows[0] as { c: number };
    mapOriginalActive = (
      await original.query(
        `SELECT COUNT(*)::int AS c FROM public.product_identifier_map WHERE deleted_at IS NULL`,
      )
    ).rows[0] as { c: number };

    const classified: EpClassification[] = unresolved.map((ep) =>
      classifyEp(ep, stagingIdx, orgProducts, orgMapIdx),
    );

    for (const c of classified) {
      classificationCounts[c.classification]++;
    }

    const safeReplayMap = new Map<string, SafeMapReplayRow>();
    for (const c of classified.filter((x) => x.classification === "safe_map_replay")) {
      const ms = c.staging_match_source!;
      const replayKey = [
        ms,
        c.staging_product_id,
        c.match_via,
        c.fnsku ?? "",
        c.sku ?? "",
        c.asin ?? "",
        c.upc ?? "",
      ].join("|");
      const existing = safeReplayMap.get(replayKey);
      if (existing) {
        existing.expected_package_ids.push(c.expected_package_id);
        existing.expected_package_count++;
      } else {
        safeReplayMap.set(replayKey, {
          replay_key: replayKey,
          match_source: ms,
          product_id: c.staging_product_id!,
          external_listing_id: null,
          seller_sku: c.match_via === "sku" ? c.sku : null,
          fnsku: c.match_via === "fnsku" ? c.fnsku : c.fnsku,
          asin: c.match_via === "asin" ? c.asin : c.asin,
          upc: c.match_via === "upc" ? c.upc : c.upc,
          match_via: c.match_via!,
          governed_execute: governedExecuteId(ms),
          map_only: MAP_ONLY_SOURCES.has(ms),
          expected_package_ids: [c.expected_package_id],
          expected_package_count: 1,
        });
      }
    }
    safeReplayRows = [...safeReplayMap.values()].sort(
      (a, b) => b.expected_package_count - a.expected_package_count,
    );

    productCreateCandidates = classified
      .filter((c) => c.classification === "product_create_candidate")
      .map((c) => ({
        expected_package_id: c.expected_package_id,
        sku: c.sku,
        fnsku: c.fnsku,
        asin: c.asin,
        upc: c.upc,
        staging_match_source: c.staging_match_source!,
        staging_product_id: c.staging_product_id!,
        staging_map_id: c.staging_map_id!,
        match_via: c.match_via!,
        reason: c.reason,
        governed_execute: governedExecuteId(c.staging_match_source!),
      }));

    conflicts = classified
      .filter((c) => c.classification === "conflict")
      .map((c) => ({
        expected_package_id: c.expected_package_id,
        classification: c.classification,
        match_via: c.match_via,
        staging_match_source: c.staging_match_source,
        staging_product_id: c.staging_product_id,
        original_product_id:
          c.match_via === "fnsku" && c.fnsku
            ? (orgMapIdx.fnskuToProduct.get(c.fnsku.toUpperCase()) ?? null)
            : c.match_via === "sku" && c.sku
              ? (orgMapIdx.skuToProduct.get(c.sku.toUpperCase()) ?? null)
              : c.match_via === "asin" && c.asin
                ? (orgMapIdx.asinToProduct.get(c.asin.toUpperCase()) ?? null)
                : c.match_via === "upc" && c.upc
                  ? (orgMapIdx.upcToProduct.get(c.upc) ?? null)
                  : null,
        identifier_value:
          c.match_via === "fnsku"
            ? c.fnsku
            : c.match_via === "sku"
              ? c.sku
              : c.match_via === "asin"
                ? c.asin
                : c.upc,
        reason: c.reason,
      }));

    await staging.end();
    await original.end();

    fs.writeFileSync(
      path.join(outDir, "unresolved-census.md"),
      [
        "# Unresolved expected_packages census — original",
        "",
        `**Run:** \`${runId}\` | **Branch:** \`${branch}\``,
        `**Original ref:** \`${ORIGINAL_REF}\` | **Staging ref:** \`${STAGING_REF}\``,
        "",
        "## Derived unresolved baseline",
        "",
        "| Metric | Count |",
        "|--------|------:|",
        `| Unresolved EP (derived, \`resolved_product_id IS NULL\`) | **${unresolvedCount.toLocaleString()}** |`,
        `| Operator baseline (resolver finish verify) | **2,413** |`,
        `| Delta vs baseline | ${unresolvedCount - 2413} |`,
        "",
        "## Identifier evidence (non-exclusive)",
        "",
        "| Evidence | EP rows |",
        "|----------|--------:|",
        `| FNSKU present | ${evidenceCounts.has_fnsku.toLocaleString()} |`,
        `| SKU present | ${evidenceCounts.has_sku.toLocaleString()} |`,
        `| UPC present | ${evidenceCounts.has_upc.toLocaleString()} |`,
        `| ASIN present | ${evidenceCounts.has_asin.toLocaleString()} |`,
        `| Missing all identifiers | ${evidenceCounts.missing_identifiers.toLocaleString()} |`,
        "",
        "## Classification vs staging governed map",
        "",
        "| Classification | EP rows |",
        "|----------------|--------:|",
        `| safe_map_replay | **${classificationCounts.safe_map_replay.toLocaleString()}** |`,
        `| product_create_candidate | ${classificationCounts.product_create_candidate.toLocaleString()} |`,
        `| conflict | ${classificationCounts.conflict.toLocaleString()} |`,
        `| no_governed_staging_match | ${classificationCounts.no_governed_staging_match.toLocaleString()} |`,
        `| missing_identifiers | ${classificationCounts.missing_identifiers.toLocaleString()} |`,
        "",
        "## Spine context (unsafe to bulk clone)",
        "",
        "| Surface | Staging active | Original active | Delta |",
        "|---------|---------------:|----------------:|------:|",
        `| \`product_identifier_map\` | ${(mapStagingActive as unknown as { c: number }).c.toLocaleString()} | ${(mapOriginalActive as unknown as { c: number }).c.toLocaleString()} | ${(mapStagingActive as unknown as { c: number }).c - (mapOriginalActive as unknown as { c: number }).c} |`,
        `| Staging governed map rows (E1/E2/E1B/PC03B cohort) | ${governedStagingMapCount.toLocaleString()} | — | — |`,
        "",
        "## Safe replay summary",
        "",
        `- **Distinct map insert candidates:** ${safeReplayRows.length.toLocaleString()}`,
        `- **EP rows covered by safe replay:** ${classificationCounts.safe_map_replay.toLocaleString()}`,
        `- **Product-create candidates:** ${productCreateCandidates.length.toLocaleString()}`,
        `- **Conflicts:** ${conflicts.length.toLocaleString()}`,
        "",
        "> Policy: never bulk `INSERT … SELECT FROM staging`. Replay governed execute plans only.",
      ].join("\n") + "\n",
    );

    fs.writeFileSync(
      path.join(outDir, "safe-map-replay-plan.json"),
      JSON.stringify(
        {
          run_id: runId,
          mode: "read_only_plan",
          db_touched: false,
          original_ref: ORIGINAL_REF,
          forbidden: ["bulk_insert_select_from_staging", "blind_copy", "auto_product_create"],
          summary: {
            distinct_map_rows: safeReplayRows.length,
            expected_packages_covered: classificationCounts.safe_map_replay,
          },
          by_execute: Object.entries(
            safeReplayRows.reduce<Record<string, { map_rows: number; ep_rows: number }>>((acc, row) => {
              const k = row.governed_execute;
              acc[k] = acc[k] ?? { map_rows: 0, ep_rows: 0 };
              acc[k].map_rows++;
              acc[k].ep_rows += row.expected_package_count;
              return acc;
            }, {}),
          ).map(([execute_id, v]) => ({ execute_id, ...v })),
          rows: safeReplayRows,
        },
        null,
        2,
      ),
    );

    fs.writeFileSync(
      path.join(outDir, "product-create-candidates.json"),
      JSON.stringify(
        {
          run_id: runId,
          count: productCreateCandidates.length,
          note: "Requires governed product promotion (E2/V200/V202) before map replay — not part of map-only Wave B execute",
          by_execute: Object.entries(
            productCreateCandidates.reduce<Record<string, number>>((acc, row) => {
              acc[row.governed_execute] = (acc[row.governed_execute] ?? 0) + 1;
              return acc;
            }, {}),
          ).map(([execute_id, count]) => ({ execute_id, count })),
          rows: productCreateCandidates,
        },
        null,
        2,
      ),
    );

    fs.writeFileSync(
      path.join(outDir, "conflict-report.md"),
      [
        "# Conflict report",
        "",
        `Total conflicts: **${conflicts.length}**`,
        "",
        conflicts.length
          ? [
              "| expected_package_id | match_via | identifier | staging_product | original_product | reason |",
              "|---------------------|-----------|------------|-----------------|------------------|--------|",
              ...conflicts.slice(0, 100).map(
                (c) =>
                  `| \`${c.expected_package_id.slice(0, 8)}…\` | ${c.match_via ?? "—"} | \`${c.identifier_value ?? "—"}\` | \`${c.staging_product_id?.slice(0, 8) ?? "—"}…\` | \`${c.original_product_id?.slice(0, 8) ?? "—"}…\` | ${c.reason} |`,
              ),
              conflicts.length > 100 ? `\n> Showing 100 of ${conflicts.length} conflicts.` : "",
            ].join("\n")
          : "No conflicts detected.",
      ].join("\n") + "\n",
    );
  }

  const safeReplayDistinct = safeReplayRows.length;
  const safeReplayEpCoverage = classificationCounts.safe_map_replay;
  const productCreateCount = productCreateCandidates.length;
  const conflictCount = conflicts.length;

  const nextPrompt =
    blockers.length > 0
      ? "ORIGINAL-PARITY-WAVE-B-GOVERNED-MAP-REPLAY-PLAN — fix blockers and re-run plan"
      : safeReplayDistinct > 0
        ? "ORIGINAL-PARITY-WAVE-B-GOVERNED-MAP-REPLAY-EXECUTE-MAP-ONLY — replay E1/E1B/PC03B governed map inserts on original (approval-gated)"
        : "ORIGINAL-PARITY-WAVE-B-GOVERNED-MAP-REPLAY-TRIAGE — no safe map-only replay rows; review product-create candidates and conflicts";

  fs.writeFileSync(
    path.join(outDir, "approval-file.md"),
    [
      "# Approval file",
      "",
      `Canonical: [\`${APPROVAL_PATH}\`](../../${APPROVAL_PATH.replace(/\\/g, "/")})`,
      "",
      "Default flags remain **false** until operator sign-off:",
      "",
      "```text",
      "APPROVED_TO_RUN_ORIGINAL=false",
      "APPROVED_ORIGINAL_PARITY_WAVE_B_GOVERNED_MAP_REPLAY=false",
      "```",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length
      ? blockers.map((b) => `- ${b}`).join("\n") + "\n"
      : unresolvedCount !== 2413
        ? `- Unresolved count ${unresolvedCount} differs from operator baseline 2413 — verify resolver state before execute\n`
        : "- None for plan stage\n",
  );

  if (!fs.existsSync(path.join(process.cwd(), APPROVAL_PATH))) {
    fs.writeFileSync(path.join(process.cwd(), APPROVAL_PATH), approvalTemplate(runId));
  } else {
    const t = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
    if (!t.includes(runId) && t.includes("Plan run_id:")) {
      fs.writeFileSync(
        path.join(process.cwd(), APPROVAL_PATH),
        t.replace(/Plan run_id:.*/, `Plan run_id: ${runId}`),
      );
    }
  }

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt_id: "ORIGINAL-PARITY-WAVE-B-GOVERNED-MAP-REPLAY-PLAN",
        run_id: runId,
        branch,
        mode: "read_only",
        db_touched: false,
        staging_ref: STAGING_REF,
        original_ref: ORIGINAL_REF,
        unresolved_count: unresolvedCount,
        baseline_unresolved: 2413,
        evidence_counts: evidenceCounts,
        classifications: classificationCounts,
        safe_replay: {
          distinct_map_rows: safeReplayDistinct,
          expected_packages_covered: safeReplayEpCoverage,
        },
        product_create_candidates: productCreateCount,
        conflicts: conflictCount,
        approval_file: APPROVAL_PATH,
        exact_next_prompt: nextPrompt,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: !blockers.length,
        outDir,
        unresolvedCount,
        safeReplayDistinct,
        safeReplayEpCoverage,
        productCreateCount,
        conflictCount,
        nextPrompt,
      },
      null,
      2,
    ),
  );
  if (blockers.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
