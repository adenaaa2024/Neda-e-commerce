/**
 * PHASE-5E-PRODUCT_IMAGE_AI_QA_AND_SAFE_REFRESH_PLAN (read-only staging audit)
 *   npx tsx scripts/phase5e-product-image-ai-qa-and-safe-refresh-plan-readonly.ts
 *   npx tsx scripts/phase5e-product-image-ai-qa-and-safe-refresh-plan-readonly.ts --run-id=20260609T120000Z
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  canonicalAmazonImageKey,
  collectAmazonCatalogImageUrls,
  scoreAmazonImageUrl,
} from "../lib/amazon-catalog-image-extract";
import {
  evaluateSuspiciousMainImage,
  isKnownBadImageUrl,
  KNOWN_BAD_IMAGE_SUBSTRINGS,
} from "../lib/pim-image-suspicious-policy";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase5e-product-image-ai-qa-and-safe-refresh";

/** Phase 5E plan: third known-bad placeholder from 1883 cluster repair fanout. */
const PLANNED_BAD_IMAGE_SUBSTRINGS = [
  ...KNOWN_BAD_IMAGE_SUBSTRINGS,
  "41gCLv9NY9L",
] as const;

const PLACEHOLDER_4152 = "4152CsQbheL";
const BLOCKED_1883_RESULT = "41gCLv9NY9L";
const FANOUT_MANUAL_REVIEW_MIN_ASINS = 10;
const SOURCE_ASIN_MISMATCH = "source_asin_mismatch";
const SHARED_ACROSS_ASINS = "shared_image_across_unrelated_asins";
const KNOWN_BAD_SHARED = "known_bad_shared_placeholder";
const LOW_RES_ONLY = "low_res_thumbnail_only";
const NOT_IN_CATALOG_CANDIDATES = "main_image_not_in_amazon_raw_candidates";
const PRODUCTION_BLOCKED = "pim_image_production_blocked";
const QA_MANUAL = "pim_image_qa_status_manual_review";

type ProductRow = {
  id: string;
  product_name: string | null;
  brand: string | null;
  asin: string | null;
  main_image_url: string | null;
  amazon_raw: unknown;
};

type ClusterRow = {
  image_url: string;
  image_key: string;
  product_count: number;
  distinct_asins: number;
  distinct_title_prefixes: number;
};

type QaDecision = "safe_to_update_staging" | "manual_review" | "blocked";

type ManualReviewRow = {
  product_id: string;
  asin: string | null;
  product_name: string | null;
  brand: string | null;
  main_image_url: string | null;
  image_key: string;
  source_asin: string | null;
  image_source: string | null;
  image_updated_at: string | null;
  pim_image_qa_status: string | null;
  pim_image_qa_reason: string | null;
  pim_image_production_blocked: string | null;
  cluster_product_count: number;
  cluster_distinct_asins: number;
  qa_decision: QaDecision;
  block_reasons: string;
  ai_qa_required: "yes" | "no";
  ai_qa_confidence: string;
  ai_qa_reason: string;
  recommended_action: string;
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

function csvEsc(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(filePath: string, headers: string[], rows: Record<string, unknown>[]): void {
  fs.writeFileSync(
    filePath,
    [headers.join(","), ...rows.map((r) => headers.map((h) => csvEsc(r[h])).join(","))].join("\n") + "\n",
    "utf8",
  );
}

function isPlannedBadImageUrl(url: string | null | undefined): boolean {
  if (!url?.trim()) return false;
  const u = url.trim();
  return PLANNED_BAD_IMAGE_SUBSTRINGS.some((s) => u.includes(s));
}

function titlePrefix(title: string | null | undefined): string {
  return String(title ?? "")
    .trim()
    .slice(0, 40)
    .toLowerCase();
}

function readAmazonRawField(amazonRaw: unknown, key: string): string | null {
  if (!amazonRaw || typeof amazonRaw !== "object" || Array.isArray(amazonRaw)) return null;
  const v = (amazonRaw as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function readProvenanceField(amazonRaw: unknown, key: string): string | null {
  if (!amazonRaw || typeof amazonRaw !== "object" || Array.isArray(amazonRaw)) return null;
  const prov = (amazonRaw as Record<string, unknown>).pim_image_provenance;
  if (!prov || typeof prov !== "object" || Array.isArray(prov)) return null;
  const v = (prov as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function resolveSourceAsin(row: ProductRow): string | null {
  return (
    readProvenanceField(row.amazon_raw, "image_source_asin") ??
    readAmazonRawField(row.amazon_raw, "image_source_asin")
  );
}

function is1883ClusterRow(row: ProductRow): boolean {
  const url = String(row.main_image_url ?? "");
  const blocked = readAmazonRawField(row.amazon_raw, "pim_image_production_blocked") ?? "";
  return (
    url.includes(PLACEHOLDER_4152) ||
    url.includes(BLOCKED_1883_RESULT) ||
    blocked.startsWith("1883_cluster:")
  );
}

function envFlagEnabled(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

async function resolveAiSettingsSource(client: pg.Client): Promise<{
  ai_enabled: "yes" | "no";
  ai_settings_source: string;
  ai_gate_flags: Record<string, boolean>;
}> {
  const gateFlags = {
    AI_EXTERNAL_HTTP_ENABLED: envFlagEnabled("AI_EXTERNAL_HTTP_ENABLED"),
    AI_PIM_IMAGE_QA_ENABLED: envFlagEnabled("AI_PIM_IMAGE_QA_ENABLED"),
    AI_PIM_DISAMBIGUATION_ENABLED: envFlagEnabled("AI_PIM_DISAMBIGUATION_ENABLED"),
  };

  const keyRows = await client.query(
    `SELECT count(*)::int AS c
     FROM public.organization_api_keys
     WHERE organization_id = $1::uuid
       AND role = 'llm_provider'
       AND coalesce(btrim(api_key), '') <> ''`,
    [ORG],
  );
  const orgKeyCount = Number((keyRows.rows[0] as { c: number }).c ?? 0);

  const legacyRows = await client.query(
    `SELECT credentials
     FROM public.organization_settings
     WHERE organization_id = $1::uuid
     LIMIT 1`,
    [ORG],
  );
  let legacyHasKey = false;
  const creds = legacyRows.rows[0]?.credentials as Record<string, unknown> | undefined;
  if (creds && typeof creds.openai_api_key === "string" && creds.openai_api_key.trim()) {
    legacyHasKey = true;
  }
  const envHasKey = Boolean(process.env.OPENAI_API_KEY?.trim());

  let ai_settings_source = "none";
  if (orgKeyCount > 0) ai_settings_source = "organization_api_keys.llm_provider";
  else if (legacyHasKey) ai_settings_source = "organization_settings.credentials.openai_api_key";
  else if (envHasKey) ai_settings_source = "OPENAI_API_KEY env (server fallback)";

  const ai_enabled =
    gateFlags.AI_EXTERNAL_HTTP_ENABLED &&
    gateFlags.AI_PIM_IMAGE_QA_ENABLED &&
    ai_settings_source !== "none"
      ? "yes"
      : "no";

  return { ai_enabled, ai_settings_source, ai_gate_flags: gateFlags };
}

function evaluateRow(args: {
  row: ProductRow;
  cluster: ClusterRow | null;
}): { decision: QaDecision; reasons: string[]; aiRequired: boolean } {
  const { row, cluster } = args;
  const reasons: string[] = [];
  const url = row.main_image_url?.trim() ?? "";
  const productAsin = String(row.asin ?? "").trim().toUpperCase();
  const sourceAsin = (resolveSourceAsin(row) ?? "").trim().toUpperCase();
  const suspicious = evaluateSuspiciousMainImage(row);

  if (is1883ClusterRow(row)) {
    reasons.push("1883_cluster_blocked");
  }
  if (isPlannedBadImageUrl(url)) {
    reasons.push(KNOWN_BAD_SHARED);
  }
  if (cluster && cluster.distinct_asins >= FANOUT_MANUAL_REVIEW_MIN_ASINS) {
    reasons.push(`${SHARED_ACROSS_ASINS}:${cluster.distinct_asins}_asins`);
  } else if (
    cluster &&
    cluster.product_count >= 3 &&
    cluster.distinct_asins >= 3 &&
    cluster.distinct_title_prefixes >= 3
  ) {
    reasons.push(`${SHARED_ACROSS_ASINS}:${cluster.distinct_asins}_asins`);
  }
  if (productAsin && sourceAsin && productAsin !== sourceAsin) {
    reasons.push(SOURCE_ASIN_MISMATCH);
  }
  if (suspicious.reasons.includes("main_image_not_in_amazon_raw_candidates")) {
    reasons.push(NOT_IN_CATALOG_CANDIDATES);
  }
  if (url && scoreAmazonImageUrl(url) < 200) {
    reasons.push(LOW_RES_ONLY);
  }
  const qaStatus = readAmazonRawField(row.amazon_raw, "pim_image_qa_status");
  if (qaStatus === "manual_review") reasons.push(QA_MANUAL);
  const prodBlocked = readAmazonRawField(row.amazon_raw, "pim_image_production_blocked");
  if (prodBlocked) reasons.push(`${PRODUCTION_BLOCKED}:${prodBlocked}`);

  const blocked = reasons.some((r) => r.startsWith("1883_cluster") || r === KNOWN_BAD_SHARED);
  if (blocked) return { decision: "blocked", reasons, aiRequired: true };

  const manual =
    reasons.some((r) => r.startsWith(SHARED_ACROSS_ASINS)) ||
    reasons.includes(SOURCE_ASIN_MISMATCH) ||
    reasons.includes(QA_MANUAL) ||
    reasons.includes(NOT_IN_CATALOG_CANDIDATES);

  if (manual) return { decision: "manual_review", reasons, aiRequired: true };

  if (!url) return { decision: "manual_review", reasons: ["missing_main_image_url"], aiRequired: false };

  return { decision: "safe_to_update_staging", reasons, aiRequired: false };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const pgUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!pgUrl.includes(STAGING_REF)) throw new Error("STAGING_DIRECT_POSTGRES_URL must target staging");
  if (pgUrl.includes(ORIGINAL_REF)) throw new Error("BLOCKED: original postgres URL");

  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const client = new pg.Client({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");

  const ai = await resolveAiSettingsSource(client);

  const fieldAudit = await client.query(
    `SELECT
       count(*)::int AS total_products,
       count(*) FILTER (WHERE main_image_url IS NOT NULL AND btrim(main_image_url) <> '')::int AS with_main_image_url,
       count(*) FILTER (
         WHERE amazon_raw ? 'pim_image_candidates'
           OR jsonb_array_length(COALESCE(amazon_raw->'pim_image_candidates', '[]'::jsonb)) > 0
       )::int AS with_pim_image_candidates,
       count(*) FILTER (
         WHERE coalesce(amazon_raw->>'image_source_asin', amazon_raw->'pim_image_provenance'->>'image_source_asin', '') <> ''
       )::int AS with_image_source_asin,
       count(*) FILTER (
         WHERE coalesce(amazon_raw->>'image_updated_at', amazon_raw->'pim_image_provenance'->>'image_updated_at', '') <> ''
       )::int AS with_image_updated_at,
       count(*) FILTER (WHERE amazon_raw ? 'pim_image_qa_status')::int AS with_pim_image_qa_status,
       count(*) FILTER (WHERE amazon_raw ? 'pim_image_production_blocked')::int AS with_pim_image_production_blocked
     FROM public.products p
     WHERE p.organization_id = $1::uuid
       AND p.store_id = $2::uuid
       AND p.deleted_at IS NULL`,
    [ORG, STORE],
  );

  const clusterRows = await client.query(
    `SELECT
       p.main_image_url,
       count(*)::int AS product_count,
       count(DISTINCT upper(btrim(p.asin))) FILTER (WHERE p.asin IS NOT NULL AND btrim(p.asin) <> '')::int AS distinct_asins,
       count(DISTINCT left(lower(btrim(p.product_name)), 40)) FILTER (WHERE p.product_name IS NOT NULL)::int AS distinct_title_prefixes
     FROM public.products p
     WHERE p.organization_id = $1::uuid AND p.store_id = $2::uuid AND p.deleted_at IS NULL
       AND p.main_image_url IS NOT NULL AND btrim(p.main_image_url) <> ''
     GROUP BY p.main_image_url
     HAVING count(*) >= 2
     ORDER BY count(*) DESC`,
    [ORG, STORE],
  );

  const clusters: ClusterRow[] = (clusterRows.rows as Array<{
    main_image_url: string;
    product_count: number;
    distinct_asins: number;
    distinct_title_prefixes: number;
  }>).map((r) => ({
    image_url: String(r.main_image_url),
    image_key: canonicalAmazonImageKey(String(r.main_image_url)),
    product_count: Number(r.product_count),
    distinct_asins: Number(r.distinct_asins),
    distinct_title_prefixes: Number(r.distinct_title_prefixes),
  }));

  const clusterByUrl = new Map(clusters.map((c) => [c.image_url, c]));

  const products = await client.query(
    `SELECT id::text, product_name, brand, asin, main_image_url, amazon_raw
     FROM public.products
     WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
       AND main_image_url IS NOT NULL AND btrim(main_image_url) <> ''`,
    [ORG, STORE],
  );

  const manualReviewRows: ManualReviewRow[] = [];
  let safeCount = 0;
  let blockedCount = 0;
  let manualCount = 0;

  for (const row of products.rows as ProductRow[]) {
    const cluster = clusterByUrl.get(String(row.main_image_url ?? "")) ?? null;
    const evald = evaluateRow({ row, cluster });
    if (evald.decision === "safe_to_update_staging") safeCount += 1;
    else if (evald.decision === "blocked") blockedCount += 1;
    else manualCount += 1;

    if (evald.decision !== "safe_to_update_staging") {
      manualReviewRows.push({
        product_id: row.id,
        asin: row.asin,
        product_name: row.product_name,
        brand: row.brand,
        main_image_url: row.main_image_url,
        image_key: canonicalAmazonImageKey(String(row.main_image_url ?? "")),
        source_asin: resolveSourceAsin(row),
        image_source:
          readProvenanceField(row.amazon_raw, "image_source") ??
          readAmazonRawField(row.amazon_raw, "image_source"),
        image_updated_at:
          readProvenanceField(row.amazon_raw, "image_updated_at") ??
          readAmazonRawField(row.amazon_raw, "image_updated_at"),
        pim_image_qa_status: readAmazonRawField(row.amazon_raw, "pim_image_qa_status"),
        pim_image_qa_reason: readAmazonRawField(row.amazon_raw, "pim_image_qa_reason"),
        pim_image_production_blocked: readAmazonRawField(row.amazon_raw, "pim_image_production_blocked"),
        cluster_product_count: cluster?.product_count ?? 1,
        cluster_distinct_asins: cluster?.distinct_asins ?? 1,
        qa_decision: evald.decision,
        block_reasons: evald.reasons.join("|"),
        ai_qa_required: evald.aiRequired ? "yes" : "no",
        ai_qa_confidence: "",
        ai_qa_reason: ai.ai_enabled === "yes" ? "pending_execute_ai_qa" : "ai_disabled_plan_only",
        recommended_action:
          evald.decision === "blocked"
            ? "keep_blocked_fetch_per_asin_catalog_image"
            : evald.decision === "manual_review"
              ? "operator_or_ai_qa_before_overwrite"
              : "eligible_for_staging_catalog_repair",
      });
    }
  }

  manualReviewRows.sort((a, b) => {
    if (a.qa_decision !== b.qa_decision) {
      const order = { blocked: 0, manual_review: 1, safe_to_update_staging: 2 };
      return order[a.qa_decision] - order[b.qa_decision];
    }
    return b.cluster_distinct_asins - a.cluster_distinct_asins;
  });

  const safeClusters = clusters.filter((c) => {
    if (isPlannedBadImageUrl(c.image_url)) return false;
    if (c.distinct_asins >= FANOUT_MANUAL_REVIEW_MIN_ASINS) return false;
    if (c.product_count >= 3 && c.distinct_asins >= 3 && c.distinct_title_prefixes >= 3) return false;
    return true;
  });

  const cluster1883 = clusters.filter(
    (c) => c.image_url.includes(BLOCKED_1883_RESULT) || c.image_url.includes(PLACEHOLDER_4152),
  );

  const knownBadBlocked = PLANNED_BAD_IMAGE_SUBSTRINGS.map((needle) => {
    const hit = clusters.find((c) => c.image_url.includes(needle));
    return {
      needle,
      in_code_known_bad_list: KNOWN_BAD_IMAGE_SUBSTRINGS.includes(
        needle as (typeof KNOWN_BAD_IMAGE_SUBSTRINGS)[number],
      ),
      staging_product_count: hit?.product_count ?? 0,
      staging_distinct_asins: hit?.distinct_asins ?? 0,
    };
  });

  const blockers: string[] = [];
  if (cluster1883.length > 0) {
    const top = cluster1883[0]!;
    blockers.push(
      `1883 cluster: ${top.product_count} products share image key ${top.image_key} across ${top.distinct_asins} ASINs — manual_review only`,
    );
  }
  if (!KNOWN_BAD_IMAGE_SUBSTRINGS.includes(BLOCKED_1883_RESULT as (typeof KNOWN_BAD_IMAGE_SUBSTRINGS)[number])) {
    blockers.push("41gCLv9NY9L not yet in KNOWN_BAD_IMAGE_SUBSTRINGS — add before next repair wave");
  }
  if (ai.ai_enabled === "no") {
    blockers.push(
      "AI image QA disabled (requires AI_EXTERNAL_HTTP_ENABLED + AI_PIM_IMAGE_QA_ENABLED + org provider key)",
    );
  }
  blockers.push("No production image overwrite until 1883 cluster resolved and operator sign-off");

  const imagesSafeToUpdateStaging = safeCount;
  const safeToApplyProduction =
    blockedCount === 0 &&
    manualCount === 0 &&
    cluster1883.length === 0 &&
    blockers.length <= 1
      ? "yes"
      : "no";

  const csvHeaders = [
    "product_id",
    "asin",
    "product_name",
    "brand",
    "main_image_url",
    "image_key",
    "source_asin",
    "image_source",
    "image_updated_at",
    "pim_image_qa_status",
    "pim_image_qa_reason",
    "pim_image_production_blocked",
    "cluster_product_count",
    "cluster_distinct_asins",
    "qa_decision",
    "block_reasons",
    "ai_qa_required",
    "ai_qa_confidence",
    "ai_qa_reason",
    "recommended_action",
  ];
  writeCsv(
    path.join(outDir, "manual-review.csv"),
    csvHeaders,
    manualReviewRows as unknown as Record<string, unknown>[],
  );

  const result = {
    phase_number: "5E",
    mode: "audit_staging_plan_only",
    run_id: rid,
    ai_enabled: ai.ai_enabled,
    ai_settings_source: ai.ai_settings_source,
    ai_gate_flags: ai.ai_gate_flags,
    known_bad_images_blocked: knownBadBlocked,
    planned_quality_rules: {
      block_known_bad_when_shared: PLANNED_BAD_IMAGE_SUBSTRINGS,
      reject_shared_across_unrelated_asins_min: FANOUT_MANUAL_REVIEW_MIN_ASINS,
      prefer_hi_res_min_score: 500,
      require_source_asin_matches_product_asin_unless_empty: true,
      catalog_source_only: "amazon_catalog_items_api_by_product_asin",
      ai_validation_only_not_source_of_truth: true,
    },
    field_audit: fieldAudit.rows[0],
    safe_clusters_count: safeClusters.length,
    unsafe_shared_clusters_count: clusters.length - safeClusters.length,
    cluster_1883: cluster1883.map((c) => ({
      image_key: c.image_key,
      product_count: c.product_count,
      distinct_asins: c.distinct_asins,
      distinct_title_prefixes: c.distinct_title_prefixes,
    })),
    manual_review_count: manualReviewRows.length,
    images_safe_to_update_staging: imagesSafeToUpdateStaging,
    images_blocked: blockedCount,
    images_manual_review: manualCount - blockedCount,
    SAFE_TO_APPLY_IMAGE_FIX_PRODUCTION: safeToApplyProduction,
    blockers,
    next_execute_prompt:
      "PHASE-5E-PRODUCT_IMAGE_AI_QA_STAGING_EXECUTE — add 41gCLv9NY9L to KNOWN_BAD_IMAGE_SUBSTRINGS, implement lib/pim-image-ai-qa.ts (vision validate title vs image, gated), re-fetch catalog per ASIN for 1883 cluster only on staging, export post-repair manual-review.csv, operator sign-off before production",
  };

  fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n", "utf8");

  fs.writeFileSync(
    path.join(outDir, "implementation-summary.md"),
    [
      "# Phase 5E — Product image AI QA + safe refresh plan",
      "",
      `- Run: \`${rid}\` · Mode: **read-only staging audit + plan**`,
      `- AI enabled (plan gate check): **${ai.ai_enabled}** · source: \`${ai.ai_settings_source}\``,
      `- Known bad placeholders (planned block list): **${PLANNED_BAD_IMAGE_SUBSTRINGS.join(", ")}**`,
      `- 1883 cluster products (4152/41gCLv9NY9L): **${cluster1883.reduce((s, c) => s + c.product_count, 0)}**`,
      `- Safe shared-image clusters: **${safeClusters.length}**`,
      `- Manual review / blocked rows in CSV: **${manualReviewRows.length}**`,
      `- Images safe to update on staging (heuristic): **${imagesSafeToUpdateStaging}**`,
      `- Images blocked: **${blockedCount}**`,
      "",
      `SAFE_TO_APPLY_IMAGE_FIX_PRODUCTION: **${safeToApplyProduction}**`,
      "",
      "## Blockers",
      ...blockers.map((b) => `- ${b}`),
      "",
      "## Next execute",
      `\`${result.next_execute_prompt}\``,
      "",
      "## Artifacts",
      "- `manual-review.csv` — unsafe/blocked products for operator review",
      "- `result.json` — machine-readable summary",
      "- `image-field-audit.md` — provenance field inventory",
      "- `quality-rules.md` — deterministic QA rules",
      "- `ai-qa-plan.md` — optional vision QA contract (validation only)",
      "- `staging-repair-plan.md` — wave order and guards",
    ].join("\n"),
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "image-field-audit.md"),
    [
      "# Product image fields and provenance (Phase 5E audit)",
      "",
      "## Canonical columns",
      "| Field | Location | Purpose |",
      "|-------|----------|---------|",
      "| `products.main_image_url` | column | Sticky display URL; overwrite only when suspicious or missing |",
      "| `products.image_url` | legacy column | Older path; may diverge from `main_image_url` |",
      "| `products.amazon_raw` | jsonb | Full Catalog Items API payload + PIM overlays |",
      "",
      "## Provenance inside `amazon_raw`",
      "| Key | Written by | Notes |",
      "|-----|------------|-------|",
      "| `pim_image_provenance` | enrichment / repair | Structured object via `buildImageProvenance` |",
      "| `image_source` | mirror | e.g. `catalog_items_api` |",
      "| `image_source_asin` | mirror | ASIN used to fetch image — must match `products.asin` when set |",
      "| `image_fetch_path` | mirror | Script/route name for audit trail |",
      "| `image_updated_at` | mirror | ISO timestamp of last image write |",
      "| `pim_image_candidates` | enrichment / repair | Up to 16 deduped catalog URLs |",
      "| `pim_image_qa_status` | phase5b execute | `manual_review` when fanout detected |",
      "| `pim_image_qa_reason` | phase5b execute | e.g. `shared_placeholder_across_N_asins` |",
      "| `pim_image_production_blocked` | phase5b execute | e.g. `1883_cluster:4152CsQbheL:staging_only` |",
      "",
      "## Staging counts",
      "```json",
      JSON.stringify(fieldAudit.rows[0], null, 2),
      "```",
      "",
      "## Resolver order (`resolvePimDisplayImageUrl`)",
      "1. `main_image_url`",
      "2. flat keys in `amazon_raw`",
      "3. best URL from catalog images block",
      "4. `pim_image_candidates`",
    ].join("\n"),
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "quality-rules.md"),
    [
      "# Image quality rules (Phase 5E)",
      "",
      "Deterministic rules run **before** any overwrite. AI is optional validation only.",
      "",
      "## 1. Known bad shared placeholders",
      "Block when URL contains any of:",
      ...PLANNED_BAD_IMAGE_SUBSTRINGS.map((s) => `- \`${s}\``),
      "",
      "Current code (`lib/pim-image-suspicious-policy.ts`) blocks only:",
      ...KNOWN_BAD_IMAGE_SUBSTRINGS.map((s) => `- \`${s}\``),
      "",
      "**Gap:** add `41gCLv9NY9L` — 1883 cluster repair fanout proved it is another shared placeholder.",
      "",
      "## 2. Shared image across unrelated ASINs",
      "- Flag `manual_review` when same canonical image key appears on ≥10 distinct ASINs.",
      "- Also flag when ≥3 products, ≥3 ASINs, ≥3 distinct title prefixes (unrelated titles).",
      "",
      "## 3. Prefer higher-res non-placeholder",
      "- Use `scoreAmazonImageUrl` + `tryUpgradeAmazonImageResolution` (`_SL75_` → `_SL500_`).",
      "- Reject picked candidate if still known-bad.",
      "",
      "## 4. Source ASIN guard",
      "- `image_source_asin` must equal `products.asin` when product ASIN is set.",
      "- Repair fetches catalog by **product ASIN only** (already enforced in `repairSuspiciousProductImage`).",
      "",
      "## 5. Overwrite policy",
      "- Default: do not overwrite good images.",
      "- Allow overwrite only when `evaluateSuspiciousMainImage` is true OR explicit staging repair wave.",
    ].join("\n"),
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "ai-qa-plan.md"),
    [
      "# Optional AI image/title QA (Phase 5E plan — not implemented)",
      "",
      "## Purpose",
      "Validate that a catalog candidate image plausibly matches product title/brand/flavor/size.",
      "AI returns **confidence + reason** only; never sole source of truth.",
      "",
      "## Settings source (server-only)",
      "1. `organization_api_keys` where `role='llm_provider'` (OpenAI)",
      "2. Legacy `organization_settings.credentials.openai_api_key`",
      "3. `OPENAI_API_KEY` env fallback",
      "",
      "## Gates (default off)",
      "- `AI_EXTERNAL_HTTP_ENABLED=1`",
      "- `AI_PIM_IMAGE_QA_ENABLED=1` (new surface — add to `lib/ai-provider-gates.ts` on execute)",
      "",
      "Current audit gate state:",
      "```json",
      JSON.stringify(ai, null, 2),
      "```",
      "",
      "## Proposed helper: `lib/pim-image-ai-qa.ts`",
      "```typescript",
      "type PimImageAiQaInput = {",
      "  organizationId: string;",
      "  productTitle: string;",
      "  brand?: string | null;",
      "  flavorOrVariant?: string | null;",
      "  imageUrl: string;",
      "};",
      "type PimImageAiQaResult = {",
      "  ok: boolean;",
      "  confidence: number; // 0..1",
      "  reason: string;",
      "  skipped?: string;",
      "};",
      "```",
      "",
      "## Decision matrix",
      "| confidence | action |",
      "|------------|--------|",
      "| ≥ 0.85 | eligible for staging overwrite (still passes deterministic rules) |",
      "| 0.60 – 0.84 | `manual_review` — do not overwrite |",
      "| < 0.60 | `blocked` — do not overwrite |",
      "| AI disabled | deterministic rules only |",
      "",
      "## Model",
      "- `gpt-4o-mini` vision, low temperature, structured JSON response.",
      "- Log to future `ai_usage_events` (meter: `ai.token` / new `ai.image_qa`).",
    ].join("\n"),
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "staging-repair-plan.md"),
    [
      "# Staging repair plan (Phase 5E)",
      "",
      "## Wave order",
      "1. **Read-only census** (this plan) — `manual-review.csv`",
      "2. **Code hardening** — add `41gCLv9NY9L` to known-bad list + blocked production needles",
      "3. **1883 cluster** — 113 products: keep `manual_review` + `pim_image_production_blocked`; per-ASIN catalog re-fetch; reject shared result image",
      "4. **High-confidence clusters only** — same pattern as phase5b next-safe waves (resolution upgrade, single ASIN or low fanout)",
      "5. **Optional AI QA** — only rows passing deterministic rules but borderline title/image fit",
      "6. **Visual QA script** — reuse `phase5b-product-image-visual-qa-and-next-clusters.ts`",
      "",
      "## Do not",
      "- Bulk refresh all catalog images",
      "- Apply staging fixes to production",
      "- Overwrite without QA status `updated` and source_asin match",
      "",
      "## Staging snapshot",
      `- Blocked (1883/known-bad): **${blockedCount}** products`,
      `- Manual review: **${manualCount - blockedCount}** products`,
      `- Safe heuristic: **${imagesSafeToUpdateStaging}** products`,
      `- Safe shared clusters: **${safeClusters.length}**`,
      "",
      "## Production gate",
      "`SAFE_TO_APPLY_IMAGE_FIX_PRODUCTION`: **" + safeToApplyProduction + "**",
    ].join("\n"),
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "PHASE-5E-PRODUCT_IMAGE_AI_QA_AND_SAFE_REFRESH_PLAN",
        run_id: rid,
        mode: "audit_staging_plan_only",
        constraints: {
          no_production: true,
          no_bulk_refresh: true,
          no_overwrite_without_qa: true,
          ai_validation_only: true,
          no_live_ai_calls: true,
        },
        artifacts: [
          "implementation-summary.md",
          "image-field-audit.md",
          "quality-rules.md",
          "ai-qa-plan.md",
          "staging-repair-plan.md",
          "manual-review.csv",
          "result.json",
          "manifest.json",
        ],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  await client.end();

  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
